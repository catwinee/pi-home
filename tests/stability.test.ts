import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, appendFile, readFile, link, lstat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { aggregate, atomicJson, mergeSessions, parseRange, parseSessionText } from "../src/stats.js";
import { TrashStore, paths, activePaths } from "../src/store.js";
import { fixture, header, msg, assistant, sample, jsonl, now } from "./fixtures.js";

test("cwd filtering follows dedup ownership; a child cwd cannot inherit its parent's token bill", () => {
  const parent = parseSessionText(jsonl(header("p", "/parent"), msg("u", "user", "same"), assistant()), "/p.jsonl");
  const child = parseSessionText(jsonl(header("c", "/child", now + 1, parent.path), msg("u", "user", "same"), assistant(), msg("u2", "user", "new")), "/c.jsonl");
  const all = aggregate([child, parent], parseRange("all"));
  const a = aggregate([child, parent], parseRange("all"), "/parent"), b = aggregate([child, parent], parseRange("all"), "/child");
  assert.equal(b.totals.input, 0); assert.equal(b.totals.users, 1); assert.equal(b.newSessions, 1);
  assert.equal(a.totals.input + b.totals.input, all.totals.input); assert.equal(a.totals.users + b.totals.users, all.totals.users);
});

test("a different session recreated at a trashed path does not erase historic accounting", () => {
  const old = parseSessionText(sample("old"), "/same.jsonl"); old.trashed = "trash-id";
  const fresh = parseSessionText(sample("fresh", now + 1000), "/same.jsonl");
  const stats = aggregate(mergeSessions([fresh], [old]), parseRange("all"));
  assert.equal(stats.totals.users, 2); assert.equal(stats.newSessions, 2); assert.equal(stats.activeSessions, 2);
  assert.equal(mergeSessions([{ ...old, trashed: undefined }], [old]).length, 1, "same restored session is deduped");
});

test("incomplete final records cannot be deleted, even without a cooperating writer", async () => {
  const f = await fixture();
  try { await appendFile(f.file, '{"type":'); await assert.rejects(new TrashStore(f.p, [f.root]).prepare(f.file), /incomplete/); }
  finally { await f.close(); }
});

test("invalid active registry schema fails closed rather than discarding its record", async () => {
  const f = await fixture();
  try {
    const lease = join(f.p.leases, "invalid.json"); await atomicJson(lease, { pid: "wrong", path: f.file });
    await assert.rejects(activePaths(f.p), /Invalid active-session/); assert.ok(await lstat(lease));
  } finally { await f.close(); }
});

test("one damaged trash record does not hide valid records; mutations fail closed", async () => {
  const f = await fixture();
  try {
    const store = new TrashStore(f.p, [f.root]), valid = await store.move(await store.prepare(f.file));
    const bad = join(f.p.trash, randomUUID()); await mkdir(bad); await writeFile(join(bad, "session.jsonl"), sample());
    await writeFile(join(bad, "record.json"), "invalid");
    const inspection = await store.inspect();
    assert.equal(inspection.records.length, 1); assert.equal(inspection.records[0]!.id, valid.id); assert.equal(inspection.diagnostics.length, 1);
    await assert.rejects(store.restore(), /Unreadable trash/);
    assert.ok(await lstat(join(bad, "session.jsonl")), "corrupt metadata never causes payload removal");
  } finally { await f.close(); }
});

test("crash before moving payload leaves only staged metadata and never counts a duplicate", async () => {
  const f = await fixture();
  try {
    await atomicJson(join(f.p.trash, randomUUID(), "record.json"), { staged: true });
    const store = new TrashStore(f.p, [f.root]), inspection = await store.inspect();
    assert.equal(inspection.records.length, 0); assert.equal(inspection.diagnostics[0]?.level, "info");
    assert.ok(await lstat(f.file)); assert.deepEqual(await store.list(), []);
  } finally { await f.close(); }
});

test("crash after restore link can be completed without overwriting or losing data", async () => {
  const f = await fixture();
  try {
    const store = new TrashStore(f.p, [f.root]), before = await readFile(f.file, "utf8");
    const r = await store.move(await store.prepare(f.file));
    await link(join(f.p.trash, r.id, "session.jsonl"), f.file); // crash between link and unlink
    assert.equal(await store.restore(r.id), f.file);
    assert.equal(await readFile(f.file, "utf8"), before); assert.equal((await store.list()).length, 0);
  } finally { await f.close(); }
});

test("a writer modifying a trashed payload is diagnosed and not silently restored", async () => {
  const f = await fixture();
  try {
    const store = new TrashStore(f.p, [f.root]), r = await store.move(await store.prepare(f.file));
    const payload = join(f.p.trash, r.id, "session.jsonl"); await appendFile(payload, "\n");
    assert.equal((await store.inspect()).records.length, 0);
    await assert.rejects(store.restore(r.id), /changed since deletion/);
    assert.ok(await lstat(payload));
  } finally { await f.close(); }
});

test("cross-filesystem move refuses safely and leaves the original intact", async t => {
  const f = await fixture(); let other: string | undefined;
  try {
    try { other = await mkdtemp("/dev/shm/pi-home-test-"); } catch { t.skip("No writable second filesystem"); return; }
    if ((await lstat(other)).dev === (await lstat(f.root)).dev) { t.skip("Same filesystem"); return; }
    const store = new TrashStore(paths(other), [f.root]), before = await readFile(f.file, "utf8");
    await assert.rejects(store.move(await store.prepare(f.file)), { code: "EXDEV" });
    assert.equal(await readFile(f.file, "utf8"), before); assert.equal((await store.inspect()).records.length, 0);
  } finally { if (other) await rm(other, { recursive: true, force: true }); await f.close(); }
});
