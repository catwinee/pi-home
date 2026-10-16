import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, appendFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { refreshCache, parseSessionText, aggregate, parseRange } from "../src/stats.js";
import { TrashStore, sessionRoots } from "../src/store.js";
import { fixture, header, msg, assistant, jsonl, sample, now } from "./fixtures.js";

async function put(path: string, contents: string) {
  await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, contents);
}

test("default grouped and current flat roots do not descend into subagent artifacts or arbitrary descendants", async () => {
  const f = await fixture();
  try {
    const project = join(f.root, "--cwd--"), artifact = join(project, "subagent-artifacts", "run_worker_transcript.jsonl");
    await put(join(project, "main.jsonl"), sample("main"));
    await put(artifact, jsonl({ role: "user", content: "artifact only" }));
    await put(join(project, "subagent-artifacts", "run_reviewer_transcript.jsonl"), jsonl(assistant()));
    await put(join(project, "session-id", "forks", "child.jsonl"), sample("child"));
    await chmod(artifact, 0); // Even unreadable artifacts must not be opened or produce errors.
    const store = new TrashStore(f.p, [f.root, project]);
    const scan = await refreshCache(store.roots, f.p.cache, store.discovery);
    assert.equal(scan.sessions.length, 2); assert.equal(scan.errors.length, 0);
    assert.ok(scan.excludedDirectories >= 2); assert.ok(!scan.diagnostics.some(d => d.path === artifact));
  } finally { await f.close(); }
});

test("explicit recursive subagent root admits real sessions, not duplicate transcript artifacts", async () => {
  const f = await fixture();
  try {
    const childRoot = join(f.dir, "children");
    await put(join(childRoot, "run-id", "run-0", "session.jsonl"), sample("child"));
    await put(join(childRoot, "run-id", "worker_transcript.jsonl"), jsonl({ role: "user", content: "duplicate" }));
    await put(join(childRoot, "run-id", "reviewer_transcript.jsonl"), jsonl(assistant()));
    const config = { startup: false, sessionRoots: [], recursiveSessionRoots: [childRoot] };
    const roots = sessionRoots(f.p, config), store = new TrashStore(f.p, roots, config.recursiveSessionRoots);
    const scan = await refreshCache(roots, f.p.cache, store.discovery);
    assert.equal(scan.sessions.length, 2); assert.equal(scan.skipped, 2); assert.equal(scan.errors.length, 0);
    assert.equal(aggregate(scan.sessions, parseRange("all")).totals.users, 2);
    assert.ok(scan.diagnostics.some(d => d.code === "non-session" && d.level === "info"));
  } finally { await f.close(); }
});

test("custom roots are flat unless explicitly recursive, overlapping roots are deduplicated", async () => {
  const f = await fixture();
  try {
    const nested = join(f.root, "nested"); await put(join(nested, "session.jsonl"), sample("nested"));
    assert.equal((await refreshCache([f.root], f.p.cache)).sessions.length, 1);
    const scan = await refreshCache([f.root, nested, f.root], f.p.cache, { recursiveRoots: [f.root] });
    assert.equal(scan.sessions.length, 2);
  } finally { await f.close(); }
});

test("artifact inside a flat root is quietly skipped; recognizable corrupt session is diagnosed", async () => {
  const f = await fixture();
  try {
    await put(join(f.root, "worker_transcript.jsonl"), jsonl({ role: "user", content: "not a session" }));
    await put(join(f.root, "2026-07-12T00-00-00_uuid.jsonl"), jsonl({ type: "message", message: { role: "user" } }));
    const scan = await refreshCache([f.root], f.p.cache);
    assert.equal(scan.skipped, 1); assert.equal(scan.errors.length, 1); assert.match(scan.errors[0]!, /Expected a Pi session/);
    assert.equal(scan.sessions.length, 1);
  } finally { await f.close(); }
});

test("previously indexed custom-named session with lost header remains a warning", async () => {
  const f = await fixture();
  try {
    await refreshCache([f.root], f.p.cache);
    await writeFile(f.file, jsonl(msg("u", "user", "header lost")));
    const scan = await refreshCache([f.root], f.p.cache);
    assert.equal(scan.errors.length, 1); assert.equal(scan.sessions.length, 0); assert.equal(scan.skipped, 0);
    const again = await refreshCache([f.root], f.p.cache);
    assert.equal(again.errors.length, 1, "Corrupt known session stays diagnosed across refreshes");
  } finally { await f.close(); }
});

test("v1 and v2 sessions are read without migrating or rewriting; BOM accepted", async () => {
  const f = await fixture();
  try {
    for (const version of [1, 2]) {
      const body = jsonl({ ...header(), version }, msg("u", "user", "legacy", now));
      const path = join(f.root, `v${version}.jsonl`); await writeFile(path, version === 1 ? `\uFEFF${body}` : body);
    }
    const before = await readFile(join(f.root, "v1.jsonl"), "utf8");
    const scan = await refreshCache([f.root], f.p.cache);
    assert.equal(scan.sessions.length, 3); assert.equal(scan.errors.length, 0);
    assert.equal(await readFile(join(f.root, "v1.jsonl"), "utf8"), before);
  } finally { await f.close(); }
});

test("unsupported versions are not counted or accepted for deletion", async () => {
  const f = await fixture();
  try {
    const body = jsonl({ ...header(), version: 100 }); await writeFile(f.file, body);
    const scan = await refreshCache([f.root], f.p.cache);
    assert.equal(scan.sessions.length, 0); assert.equal(scan.errors.length, 1);
    await assert.rejects(new TrashStore(f.p, [f.root]).prepare(f.file), /Unsupported/);
    assert.equal(await readFile(f.file, "utf8"), body);
  } finally { await f.close(); }
});

test("in-progress header and partial tail are info; interior malformed records remain warnings", async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "session.jsonl"), body = sample("pending");
    await writeFile(path, body.slice(0, 30));
    const pending = await refreshCache([f.root], f.p.cache);
    assert.equal(pending.pending, 1); assert.equal(pending.errors.length, 0);
    await appendFile(path, body.slice(30));
    const complete = await refreshCache([f.root], f.p.cache);
    assert.equal(complete.sessions.length, 2); assert.equal(complete.pending, 0);
    const s = parseSessionText(jsonl(header()) + 'bad record\n' + jsonl(msg("u", "user", "valid")) + '{"partial":', path);
    assert.equal(s.warnings, 1); assert.equal(s.pendingTail, true);
  } finally { await f.close(); }
});

test("simultaneous identical scans share one promise without coalescing different roots", async () => {
  const f = await fixture();
  try {
    const a = refreshCache([f.root], f.p.cache), b = refreshCache([f.root], f.p.cache);
    assert.equal(a, b); assert.equal((await a).sessions.length, 1);
    const c = refreshCache([f.root], f.p.cache); assert.notEqual(a, c); assert.equal((await c).reused, 1);
  } finally { await f.close(); }
});
