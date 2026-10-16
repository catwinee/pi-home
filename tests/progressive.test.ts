import test from "node:test";
import assert from "node:assert/strict";
import { lstat, readFile, writeFile, unlink } from "node:fs/promises";
import { runCooperatively } from "../src/cooperative.js";
import { aggregate, aggregateCooperatively, atomicJson, loadCache, mergeSessions, parseRange, parseSessionText, refreshCache, shiftDay } from "../src/stats.js";
import { assistant, fixture, header, iso, jsonl, msg, now, sample, usage } from "./fixtures.js";

test("warm unchanged scans preserve cache bytes/inode/mtime while changed and deleted files invalidate it", async () => {
  const f = await fixture();
  try {
    await refreshCache([f.root], f.p.cache);
    const before = await lstat(f.p.cache), bytes = await readFile(f.p.cache, "utf8");
    const warm = await refreshCache([f.root], f.p.cache), after = await lstat(f.p.cache);
    assert.equal(warm.reused, 1); assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(await readFile(f.p.cache, "utf8"), bytes);
    // Serialization remains v2 JSON, including quoted/unicode paths and text.
    await writeFile(f.file, jsonl(header("changed", '/work/"中文'), msg("u", "user", 'text "quoted" \\ slash')));
    const changed = await refreshCache([f.root], f.p.cache);
    assert.equal(changed.reused, 0); assert.equal(changed.sessions[0]?.id, "changed");
    assert.deepEqual(JSON.parse(await readFile(f.p.cache, "utf8")), changed.cache);
    assert.deepEqual(await loadCache(f.p.cache), changed.cache);
    await unlink(f.file);
    assert.deepEqual((await refreshCache([f.root], f.p.cache)).cache.files, {});
    assert.deepEqual((await loadCache(f.p.cache)).knownPaths, []);
  } finally { await f.close(); }
});

test("empty missing/corrupt/legacy caches are repaired; known damaged sessions still warn on repeated scans", async () => {
  const f = await fixture();
  try {
    await refreshCache([f.root], f.p.cache);
    await writeFile(f.file, '{"type":"message"}\n');
    for (let i = 0; i < 2; i++) {
      const scan = await refreshCache([f.root], f.p.cache);
      assert.ok(scan.diagnostics.some(d => d.level === "warning"));
      assert.deepEqual(scan.cache.knownPaths, [f.file]);
    }
    await unlink(f.file);
    for (const content of [undefined, "broken", '{"version":2,"files":{}}', '{"version":1,"files":{}}']) {
      if (content === undefined) await unlink(f.p.cache); else await writeFile(f.p.cache, content);
      const scan = await refreshCache([f.root], f.p.cache);
      assert.deepEqual(JSON.parse(await readFile(f.p.cache, "utf8")), scan.cache);
      assert.deepEqual(scan.cache, { version: 2, files: {}, knownPaths: [] });
    }
    await atomicJson(f.p.cache, { version: 2, knownPaths: [], files: { bad: { session: {} } } });
    assert.deepEqual((await loadCache(f.p.cache)).files, {});
  } finally { await f.close(); }
});

test("cooperative parsing preserves partial-tail and all-branch accounting on a large single session", async () => {
  const f = await fixture();
  try {
    const raw = jsonl(header(), ...Array.from({ length: 3000 }, (_, i) => assistant(`a${i}`, now + i))) + '{"type":';
    await writeFile(f.file, raw);
    const scan = await refreshCache([f.root], f.p.cache);
    assert.deepEqual(scan.sessions[0], parseSessionText(raw, f.file));
    assert.equal(scan.pending, 1); assert.equal(scan.sessions[0]?.events.length, 3000);
  } finally { await f.close(); }
});

test("multi-range cooperative aggregation preserves fork ownership, unknown usage, dates, cwd and trash", async () => {
  const yesterday = shiftDay(now, -1);
  const parent = parseSessionText(sample("parent", yesterday), "/parent.jsonl");
  const child = parseSessionText(jsonl(header("child", "", now, parent.path),
    msg("u", "user", "请排查中文缓存问题", yesterday), assistant("a", yesterday + 1),
    msg("new", "user", "today", now),
    msg("nested", "toolResult", "error", now, { isError: true, usage, nestedCalls: { complete: false, calls: [{ name: "read" }] } }),
    { type: "compaction", id: "summary", timestamp: iso(), summary: "unknown usage" }), "/child.jsonl");
  const other = parseSessionText(sample("unrelated"), "/other.jsonl");
  const restored = { ...parent, trashed: "trash-id" };
  const sessions = mergeSessions([child, parent, other], [restored]);
  const ranges = [parseRange("today", now), parseRange("all"), parseRange("7d", now), { label: "empty", start: now + 10000 }];
  for (const cwd of [undefined, "", "/work/项目", "/nonexistent"]) {
    const actual = await aggregateCooperatively(sessions, ranges, cwd);
    assert.deepEqual(actual, ranges.map(range => aggregate(sessions, range, cwd)));
  }
  const [scoped] = await aggregateCooperatively(sessions, [parseRange("all")], "");
  assert.equal(scoped?.totals.users, 1); assert.equal(scoped?.totals.input, 10);
  assert.equal(scoped?.totals.unknownUsage, 1); assert.equal(scoped?.totals.errors, 1);
  assert.equal(scoped?.totals.incompleteNested, 1);
  const live = [parent], copied = mergeSessions(live, []); assert.notEqual(copied, live); assert.deepEqual(copied, live);
});

test("cooperative runner lets real event-loop work run between slices and supports cancellation", async () => {
  let processed = 0, interruptedAt = -1, released = false;
  const controller = new AbortController();
  function* steps(): Generator<void, number> {
    try {
      while (processed < 100) {
        // Deliberately nontrivial single steps, not machine-dependent timing assertions.
        const end = performance.now() + 1;
        while (performance.now() < end) { /* CPU work */ }
        processed++; yield;
      }
      return processed;
    } finally { released = true; }
  }
  const work = runCooperatively(steps(), controller.signal);
  const cancelDuringWork = () => {
    if (!processed) { setImmediate(cancelDuringWork); return; }
    interruptedAt = processed; controller.abort();
  };
  setImmediate(cancelDuringWork);
  await assert.rejects(work, { name: "AbortError" });
  assert.ok(interruptedAt > 0 && interruptedAt < 100);
  assert.equal(processed, interruptedAt); assert.ok(released);
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  await assert.rejects(aggregateCooperatively([], [parseRange("all")], undefined, alreadyAborted.signal), { name: "AbortError" });
});

test("large multi-range aggregation yields more than once, without exposing partial results", async () => {
  const session = parseSessionText(sample(), "/synthetic.jsonl");
  session.events = Array.from({ length: 20000 }, (_, i) => ({ ...session.events[1]!, key: `event-${i}` }));
  let turns = 0, finished = false;
  const tick = () => { turns++; if (!finished) setImmediate(tick); };
  const work = aggregateCooperatively([session], [parseRange("today", now), parseRange("all")]);
  setImmediate(tick);
  try {
    const result = await work;
    assert.equal(result[0]?.totals.assistants, 20000); assert.equal(result[1]?.totals.assistants, 20000);
    assert.ok(turns > 1, `expected real yields during processing, observed ${turns}`);
  } finally { finished = true; }
});
