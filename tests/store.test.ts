import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, readFile, writeFile, lstat, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ActiveLease, TrashStore, activePaths, loadConfig, sessionRoots } from "../src/store.js";
import { aggregate, parseRange, refreshCache, atomicJson } from "../src/stats.js";
import { fixture, sample } from "./fixtures.js";

test("trash preserves exact bytes; undo restores and never changes totals", async () => {
  const f = await fixture();
  try {
    const store = new TrashStore(f.p, [f.root]);
    const original = await readFile(f.file, "utf8"), ticket = await store.prepare(f.file);
    const before = aggregate([ticket.session], parseRange("all"));
    const record = await store.move(ticket);
    await assert.rejects(lstat(f.file), { code: "ENOENT" });
    assert.equal(await readFile(join(f.p.trash, record.id, "session.jsonl"), "utf8"), original);
    assert.equal((await store.list()).length, 1);
    assert.deepEqual(aggregate((await store.list()).map(r => r.session), parseRange("all")).totals, before.totals);
    assert.equal((await store.read(record)).documents.length, ticket.session.documents.length);
    assert.equal(await store.restore(), f.file);
    assert.equal(await readFile(f.file, "utf8"), original); assert.equal((await store.list()).length, 0);
  } finally { await f.close(); }
});
test("current and cooperatively active sessions cannot be removed", async () => {
  const f = await fixture(); const lease = new ActiveLease(f.p);
  try {
    const store = new TrashStore(f.p, [f.root]), ticket = await store.prepare(f.file);
    await assert.rejects(store.move(ticket, f.file), /current session/);
    await lease.set(f.file); assert.ok((await activePaths(f.p)).has(f.file));
    await assert.rejects(store.move(ticket), /active/);
    await lease.close(); await store.move(ticket);
  } finally { await lease.close(); await f.close(); }
});
test("modified file is rejected after confirmation", async () => {
  const f = await fixture();
  try {
    const store = new TrashStore(f.p, [f.root]), ticket = await store.prepare(f.file);
    await appendFile(f.file, "\n");
    await assert.rejects(store.move(ticket), /changed/);
    assert.equal((await store.list()).length, 0); assert.ok(await lstat(f.file));
  } finally { await f.close(); }
});
test("restore does not overwrite a recreated destination", async () => {
  const f = await fixture();
  try {
    const store = new TrashStore(f.p, [f.root]); await store.move(await store.prepare(f.file));
    await writeFile(f.file, "new session"); await assert.rejects(store.restore(), { code: "EEXIST" });
    assert.equal(await readFile(f.file, "utf8"), "new session"); assert.equal((await store.list()).length, 1);
  } finally { await f.close(); }
});
test("outside roots, symlinks and bad headers are refused", async () => {
  const f = await fixture();
  try {
    const store = new TrashStore(f.p, [f.root]);
    const outside = join(f.dir, "outside.jsonl"); await writeFile(outside, sample());
    await assert.rejects(store.prepare(outside), /outside/);
    const linked = join(f.root, "link.jsonl"); await symlink(f.file, linked);
    await assert.rejects(store.prepare(linked), /Symlink/);
    await writeFile(f.file, "{}"); await assert.rejects(store.prepare(f.file), /header/);
  } finally { await f.close(); }
});
test("cross-process cleanup lock blocks mutations and preserves data", async () => {
  const f = await fixture();
  try {
    const store = new TrashStore(f.p, [f.root]);
    await atomicJson(join(f.p.home, "trash.lock"), { pid: process.pid });
    await assert.rejects(store.move(await store.prepare(f.file)), /cleanup is running/);
    assert.ok(await lstat(f.file));
  } finally { await f.close(); }
});
test("dead leases are cleaned, corrupt live registry fails closed", async () => {
  const f = await fixture();
  try {
    const dead = join(f.p.leases, "dead.json"); await atomicJson(dead, { pid: 1073741824, path: f.file });
    assert.equal((await activePaths(f.p)).size, 0); await assert.rejects(lstat(dead), { code: "ENOENT" });
    await writeFile(dead, "bad json");
    await assert.rejects(new TrashStore(f.p, [f.root]).move(await new TrashStore(f.p, [f.root]).prepare(f.file)), /registry/);
  } finally { await f.close(); }
});
test("private cache and trash metadata permissions", async () => {
  const f = await fixture();
  try {
    await refreshCache([f.root], f.p.cache); assert.equal((await lstat(f.p.cache)).mode & 0o777, 0o600);
    const store = new TrashStore(f.p, [f.root]), r = await store.move(await store.prepare(f.file));
    assert.equal((await lstat(join(f.p.trash, r.id))).mode & 0o777, 0o700);
  } finally { await f.close(); }
});
test("custom roots and config survive startup toggle payloads", async () => {
  const f = await fixture();
  try {
    assert.equal((await loadConfig(f.p)).startup, true);
    await atomicJson(f.p.config, { startup: false, sessionRoots: ["/custom", "relative", 123] });
    const c = await loadConfig(f.p); assert.equal(c.startup, false); assert.deepEqual(c.sessionRoots, ["/custom"]);
    assert.ok(sessionRoots(f.p, c, "/current").includes("/current"));
  } finally { await f.close(); }
});
