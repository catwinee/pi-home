import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, unlink, appendFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { aggregate, dayKey, parseDay, shiftDay, parseRange, parseSessionText, searchSessions, refreshCache, loadCache, safeText, atomicJson } from "../src/stats.js";
import { now, iso, usage, header, msg, assistant, jsonl, sample, fixture } from "./fixtures.js";

test("counts users, assistant calls, direct and nested tools separately", () => {
  const raw = jsonl(header(), msg("u", "user", "hello"), assistant(), msg("r", "toolResult", [{ type: "text", text: "output" }], now + 2,
    { isError: true, nestedCalls: { complete: false, calls: [{ name: "read" }] }, usage }));
  const s = parseSessionText(raw, "/session.jsonl"), a = aggregate([s], parseRange("all"));
  assert.equal(a.totals.users, 1); assert.equal(a.totals.assistants, 1); assert.equal(a.totals.tools, 1);
  assert.equal(a.totals.nestedTools, 1); assert.equal(a.totals.errors, 1); assert.equal(a.totals.incompleteNested, 1);
  assert.equal(a.totals.input, 20); assert.equal(a.models.length, 2);
  assert.equal(a.tools.find(b => b.key === "read")?.nestedTools, 1);
});
test("usage includes summaries and unknown usage kinds; unrecorded model stays unattributed", () => {
  const s = parseSessionText(jsonl(header(), { type: "compaction", id: "c", timestamp: iso(), summary: "summary", usage },
    { type: "branch_summary", id: "b", timestamp: iso(), summary: "branch", usage },
    { type: "usage", kind: "future-kind", id: "warm", timestamp: iso(), provider: "p", model: "m", usage }), "/one.jsonl");
  const a = aggregate([s], parseRange("all"));
  assert.equal(a.totals.input, 30); assert.equal(a.totals.cacheRead, 90);
  assert.equal(a.models.find(b => b.key === "unattributed/unattributed")?.input, 20);
});
test("physical responseModel takes precedence over the requested alias", () => {
  const s = parseSessionText(jsonl(header(), msg("a", "assistant", "ok", now, { provider: "p", model: "alias", responseModel: "physical", usage })), "/s.jsonl");
  assert.equal(aggregate([s], parseRange("all")).models[0]?.key, "p/physical");
});
test("missing usage is reported rather than silently treated as known zero", () => {
  const s = parseSessionText(jsonl(header(), msg("a", "assistant", "no usage")), "/one.jsonl");
  const a = aggregate([s], parseRange("all")); assert.equal(a.totals.unknownUsage, 1); assert.equal(a.totals.input, 0);
});
test("explicit zero usage is known; reasoning tokens are not counted twice", () => {
  const s = parseSessionText(jsonl(header(), msg("a", "assistant", "text", now, { usage: { ...usage, reasoning: 5 } })), "/a.jsonl");
  assert.equal(aggregate([s], parseRange("all")).totals.output, 20);
});
test("date buckets use event timestamps, distinguish new from active", () => {
  const yesterday = shiftDay(now, -1);
  const s = parseSessionText(jsonl(header("old", "/cwd", yesterday), msg("u", "user", "today", now), assistant("a", yesterday)), "/one.jsonl");
  const a = aggregate([s], parseRange("today", now));
  assert.equal(a.newSessions, 0); assert.equal(a.activeSessions, 1); assert.equal(a.totals.users, 1); assert.equal(a.totals.input, 0);
});
test("fork inherited history is counted once and belongs to the ancestor, independent of input order", () => {
  const parent = parseSessionText(sample(), "/sessions/parent.jsonl");
  const child = parseSessionText(jsonl(header("child", "/child", now + 100, parent.path), msg("u", "user", "请排查中文缓存问题", now), assistant("a", now + 1), msg("u2", "user", "new", now + 200)), "/sessions/child.jsonl");
  const a = aggregate([child, parent], parseRange("all"));
  assert.equal(a.totals.users, 2); assert.equal(a.totals.input, 10);
  assert.equal(a.projects.find(b => b.key === "/work/项目")?.input, 10);
  assert.equal(a.projects.find(b => b.key === "/child")?.input, 0);
});
test("unrelated sessions with identical IDs and text are not deduplicated", () => {
  const a = aggregate([parseSessionText(sample(), "/a.jsonl"), parseSessionText(sample("two"), "/b.jsonl")], parseRange("all"));
  assert.equal(a.totals.users, 2); assert.equal(a.totals.input, 20);
});
test("all branches retained and copied parentId changes do not prevent dedup", () => {
  const first = { ...assistant(), parentId: "old" }, copy = { ...first, parentId: "other" };
  const a = parseSessionText(jsonl(header(), first, msg("alternative", "user", "other branch")), "/a.jsonl");
  const b = parseSessionText(jsonl(header("two", "/cwd", now, a.path), copy), "/b.jsonl");
  assert.equal(aggregate([b, a], parseRange("all")).totals.assistants, 1);
  assert.equal(aggregate([b, a], parseRange("all")).totals.users, 1);
});
test("Chinese substring, quoted phrases, metadata, snippets and optional tool/thinking search", () => {
  const s = parseSessionText(jsonl(header(), msg("u", "user", "中文问题"), assistant(), msg("r", "toolResult", "TOOL_ONLY")), "/s.jsonl");
  assert.equal(searchSessions([s], "中文").length, 1);
  assert.ok(searchSessions([s], "缓存")[0]?.snippet.includes("缓存"));
  assert.equal(searchSessions([s], '"private reasoning"').length, 0);
  assert.equal(searchSessions([s], '"private reasoning"', true).length, 1);
  assert.equal(searchSessions([s], "TOOL_ONLY").length, 0);
  assert.equal(searchSessions([s], "TOOL_ONLY", true).length, 1);
  assert.equal(searchSessions([s], "", false, "/different").length, 0);
});
test("malformed and partial JSONL is reported; invalid header is rejected", () => {
  const s = parseSessionText(sample() + '{"type":', "/one.jsonl");
  assert.equal(s.warnings, 0); assert.equal(s.pendingTail, true); assert.equal(s.events.length, 2);
  assert.throws(() => parseSessionText(jsonl(msg("u", "user", "x")), "/bad.jsonl"), /header/);
});
test("system prompt and image payloads do not enter text index", () => {
  const s = parseSessionText(jsonl(header(), msg("sys", "system", "SYSTEM_SECRET"), msg("u", "user", [{ type: "image", data: "BASE64_SECRET", mimeType: "image/png" }])), "/s.jsonl");
  assert.equal(searchSessions([s], "SECRET", true).length, 0);
  assert.match(s.documents[0]!.text, /image\/png/);
});
test("terminal control sequences are stripped", () => {
  const text = safeText("abc\x1b[31mRED\x1b[0m\x1b]52;c;secret\x07\u202efoo");
  assert.equal(text, "abcREDfoo"); assert.ok(!text.includes("\x1b"));
});
test("local day ranges handle DST instead of adding fixed 24h", () => {
  const old = process.env.TZ; process.env.TZ = "America/New_York";
  try {
    const r = parseRange("2026-03-08..2026-03-08"); assert.equal((r.end! - r.start!) / 3600000, 23);
    assert.equal(dayKey(parseDay("2026-03-08")!), "2026-03-08");
    assert.throws(() => parseRange("2026-02-30..2026-03-01"));
    assert.throws(() => parseRange("2026-03-10..2026-03-01"));
  } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
});
test("incremental cache, rewrite/shrink, deleted files and corrupt cache", async () => {
  const f = await fixture();
  try {
    const first = await refreshCache([f.root], f.p.cache); assert.equal(first.sessions.length, 1); assert.equal(first.reused, 0);
    const second = await refreshCache([f.root], f.p.cache); assert.equal(second.reused, 1);
    await writeFile(f.file, jsonl(header()));
    const third = await refreshCache([f.root], f.p.cache); assert.equal(third.sessions[0]?.events.length, 0);
    await writeFile(f.p.cache, "broken"); assert.deepEqual((await loadCache(f.p.cache)).files, {});
    await unlink(f.file); assert.equal((await refreshCache([f.root], f.p.cache)).sessions.length, 0);
  } finally { await f.close(); }
});
test("missing roots and symlink loops are safe; overlapping roots do not double count", async () => {
  const f = await fixture();
  try {
    await symlink(f.root, join(f.root, "loop"));
    const scan = await refreshCache([f.root, f.root, join(f.root, "missing")], f.p.cache);
    assert.equal(scan.sessions.length, 1);
    await appendFile(f.file, '{"broken":');
    const warnings = await refreshCache([f.root], f.p.cache); assert.equal(warnings.pending, 1); assert.equal(warnings.errors.length, 0);
    const reused = await refreshCache([f.root], f.p.cache); assert.equal(reused.reused, 1); assert.equal(reused.pending, 1);
  } finally { await f.close(); }
});
test("invalid structured cache rebuilds safely", async () => {
  const f = await fixture();
  try {
    await atomicJson(f.p.cache, { version: 1, files: { bad: { session: {} } } });
    assert.deepEqual((await loadCache(f.p.cache)).files, {});
    assert.equal((await refreshCache([f.root], f.p.cache)).sessions.length, 1);
  } finally { await f.close(); }
});
