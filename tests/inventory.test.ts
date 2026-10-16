import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { scanInventory, formatBytes } from "../src/inventory.js";
import { paths } from "../src/store.js";
import { parseSessionText, searchSessions } from "../src/stats.js";
import { header, jsonl } from "./fixtures.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-home-inventory-")), p = paths(join(dir, "agent"));
  const root = join(p.agentDir, "sessions"), shared = join(root, "shared"), cwd = join(dir, "project-a"), other = join(dir, "project-b");
  const temp = join(dir, "private-temp");
  async function put(path: string, text: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); }
  await put(join(shared, "one.jsonl"), jsonl(header("one", cwd)) + "INVALID BODY — MUST NOT BE PARSED\n");
  await put(join(shared, "two.jsonl"), jsonl(header("two", other)));
  await put(join(shared, "subagent-artifacts", "report.md"), "12345");
  await put(join(shared, "subagent-artifacts", "outputs", "result.txt"), "abcdefg");
  await put(join(shared, "notes.log"), "unknown log");
  await put(join(shared, "unrecognized", "do-not-read.txt"), "unknown subtree");
  await put(join(cwd, ".pi", "subagents", "artifacts", "project.md"), "keep this final output");
  await put(join(other, ".pi", "subagents", "artifacts", "not-scanned.md"), "historical cwd is NOT a traversal grant");
  await put(join(cwd, "not-a-plugin", "private.txt"), "must not inspect unrelated project files");
  await put(join(temp, "async-subagent-runs", "run1", "status.json"), "INVALID JSON — METADATA ONLY");
  await put(p.cache, "UNCHANGED CACHE — NOT PARSED");
  await put(join(p.trash, "trash1", "record.json"), "INVALID JSON — DO NOT REPAIR");
  await put(join(p.trash, "trash1", "session.jsonl"), jsonl(header("trashed", cwd)));
  const options = { cwd, sessionDir: shared, groupedRoots: [root], tempRoot: temp };
  return { dir, p, root, shared, cwd, other, temp, options, put, close: () => rm(dir, { recursive: true, force: true }) };
}
async function fingerprint(dir: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(path: string) {
    const s = await lstat(path);
    result.push(`${path}:${s.mode}:${s.size}:${s.mtimeMs}`);
    if (s.isDirectory()) for (const name of (await readdir(path)).sort()) await walk(join(path, name));
    else if (s.isFile()) result.push(createHash("sha256").update(await readFile(path)).digest("hex"));
  }
  await walk(dir); return result;
}
test("inventory reads headers only, groups exact cwd values and separates shared storage from ownership", async () => {
  const f = await fixture();
  try {
    const result = await scanInventory(f.p, [f.root], f.options);
    const a = result.workspaces.find(w => w.cwd === f.cwd)!, b = result.workspaces.find(w => w.cwd === f.other)!;
    assert.equal(a.sessions.length, 1); assert.equal(b.sessions.length, 1);
    assert.equal(a.bytes, (await lstat(join(f.shared, "one.jsonl"))).size);
    assert.deepEqual(a.storageDirs, [f.shared]);
    assert.equal(result.workspaces.reduce((n, w) => n + w.sessions.length, 0), 2, "no artifacts or trash mistaken for saved sessions");
    const artifacts = result.locations.find(l => l.path === join(f.shared, "subagent-artifacts"))!;
    assert.equal(artifacts.bytes, 12); assert.equal(artifacts.files, 2);
    assert.deepEqual(artifacts.cwds, [f.cwd, f.other]);
    assert.match(artifacts.notes.join(" "), /Shared storage/);
    assert.equal(artifacts.items.find(i => i.path.endsWith("outputs"))!.bytes, 7);
    assert.ok(result.locations.some(l => l.kind === "unclassified" && l.items.some(i => i.path.endsWith("unrecognized") && i.partial)));
  } finally { await f.close(); }
});
test("recorded cwd remains an exact grouping key, never a path traversal instruction", async () => {
  const f = await fixture();
  try {
    const raw = jsonl(header("relative", "../not-a-scan-target")), blank = jsonl(header("blank", ""));
    await f.put(join(f.shared, "relative.jsonl"), raw); await f.put(join(f.shared, "blank.jsonl"), blank);
    const result = await scanInventory(f.p, [f.root], f.options);
    assert.equal(result.workspaces.find(w => w.cwd === "../not-a-scan-target")!.sessions.length, 1);
    assert.equal(result.workspaces.find(w => w.cwd === "")!.sessions.length, 1);
    assert.ok(!result.scope.some(line => line.includes("not-a-scan-target")));
    const sessions = [parseSessionText(raw, "/relative.jsonl"), parseSessionText(blank, "/blank.jsonl")];
    assert.equal(searchSessions(sessions, "", false, "").length, 1);
    assert.equal(searchSessions(sessions, "", false, "../not-a-scan-target").length, 1);
  } finally { await f.close(); }
});
test("only current cwd's known plugin paths are inspected, temp/cache/trash remain shared and nothing is written", async () => {
  const f = await fixture();
  try {
    const before = await fingerprint(f.dir), result = await scanInventory(f.p, [f.root], f.options);
    assert.deepEqual(await fingerprint(f.dir), before);
    assert.ok(result.locations.some(l => l.path.startsWith(f.cwd + "/.pi/subagents/")));
    assert.ok(!result.locations.some(l => l.path.startsWith(f.other)));
    assert.ok(!JSON.stringify(result).includes("private.txt"));
    for (const l of result.locations.filter(l => l.kind === "cache" || l.kind === "trash" || l.path.startsWith(f.temp))) assert.deepEqual(l.cwds, []);
    assert.equal(result.locations.find(l => l.kind === "trash")!.files, 2);
    assert.ok(result.scope.some(line => line.includes(f.temp)));
  } finally { await f.close(); }
});
test("symlinks, symlinked ancestors and cycles are never followed", async () => {
  const f = await fixture();
  try {
    const outside = join(f.dir, "outside"); await f.put(join(outside, "secret.jsonl"), jsonl(header("secret", "/not-authorized")));
    await symlink(outside, join(f.shared, "linked.jsonl"));
    await symlink(outside, join(f.shared, "subagent-artifacts", "outside"));
    await symlink(join(f.shared, "subagent-artifacts"), join(f.shared, "subagent-artifacts", "loop"));
    const alias = join(f.dir, "alias"); await symlink(f.root, alias);
    const result = await scanInventory(f.p, [f.root, join(alias, "shared")], f.options);
    assert.equal(result.workspaces.some(w => w.cwd === "/not-authorized"), false);
    assert.equal(result.locations.find(l => l.path.endsWith("subagent-artifacts"))!.bytes, 12);
    assert.equal(result.locations.find(l => l.path.endsWith("subagent-artifacts"))!.symlinks, 2);
    assert.ok(result.diagnostics.some(d => d.code === "symlink-or-directory" && d.path.startsWith(alias)));
  } finally { await f.close(); }
});
test("entry and depth budgets return explicit partial lower bounds, not fabricated complete totals", async () => {
  const f = await fixture();
  try {
    const limited = await scanInventory(f.p, [f.root], { ...f.options, limits: { entries: 2 } });
    assert.ok(limited.partial); assert.ok(limited.visited <= 2); assert.ok(limited.diagnostics.some(d => d.code === "partial-inventory"));
    const shallow = await scanInventory(f.p, [f.root], { ...f.options, limits: { depth: 1 } });
    const artifact = shallow.locations.find(l => l.path.endsWith("subagent-artifacts"))!;
    assert.ok(artifact.partial); assert.equal(artifact.bytes, 5); assert.match(artifact.notes.join(" "), /lower bounds/);
  } finally { await f.close(); }
});
test("largest-entry display limit does not reduce aggregate counts", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 5; i++) await f.put(join(f.shared, "subagent-artifacts", `file-${i}`), "a".repeat(10 + i));
    const result = await scanInventory(f.p, [f.root], { ...f.options, limits: { items: 2 } });
    const l = result.locations.find(l => l.path.endsWith("subagent-artifacts"))!;
    assert.equal(l.files, 7); assert.equal(l.bytes, 72); assert.equal(l.itemCount, 7); assert.equal(l.items.length, 2);
    assert.equal(l.items[0]!.bytes, 14); assert.match(l.notes.join(" "), /largest 2 of 7/);
  } finally { await f.close(); }
});
test("overlapping session roots do not duplicate sessions or direct unclassified files", async () => {
  const f = await fixture();
  try {
    const result = await scanInventory(f.p, [f.root, f.shared], { ...f.options, recursiveRoots: [f.shared] });
    assert.equal(result.workspaces.reduce((n, w) => n + w.sessions.length, 0), 2);
    const leftovers = result.locations.find(l => l.kind === "unclassified" && l.path === f.shared)!;
    assert.equal(leftovers.items.filter(i => i.path.endsWith("notes.log")).length, 1);
    assert.ok(!leftovers.items.some(i => i.path.endsWith("unrecognized")), "expanded directory is not reported twice");
  } finally { await f.close(); }
});
test("unknown artifact-only storage stays unassigned; recorded directory names are not decoded as cwd", async () => {
  const f = await fixture();
  try {
    const orphan = join(f.root, "--deleted-project--", "subagent-artifacts"); await f.put(join(orphan, "report.md"), "123");
    const result = await scanInventory(f.p, [f.root], f.options);
    assert.deepEqual(result.locations.find(l => l.path === orphan)!.cwds, []);
    assert.ok(!result.workspaces.some(w => w.cwd.includes("deleted-project")));
  } finally { await f.close(); }
});
test("aborted inventory stops without writes; empty storage still shows current workspace", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(scanInventory(f.p, [f.root], { ...f.options, signal: controller.signal }), { name: "AbortError" });
    const p = paths(join(f.dir, "missing-agent"));
    const result = await scanInventory(p, [join(p.agentDir, "sessions")], { cwd: join(f.dir, "empty-current") });
    assert.deepEqual(result.workspaces.map(w => [w.cwd, w.sessions.length]), [[join(f.dir, "empty-current"), 0]]);
    await assert.rejects(lstat(p.agentDir), { code: "ENOENT" });
  } finally { await f.close(); }
});
test("oversized/malformed/unsupported headers stay unclassified without leaking body data", async () => {
  const f = await fixture();
  try {
    await f.put(join(f.shared, "huge.jsonl"), jsonl({ ...header("huge", f.cwd), padding: "x".repeat(70000) }));
    await f.put(join(f.shared, "future.jsonl"), jsonl({ ...header("future", f.cwd), version: 99 }));
    await f.put(join(f.shared, "broken.jsonl"), "not-json\\nPRIVATE_BODY_SENTINEL");
    const result = await scanInventory(f.p, [f.root], f.options);
    assert.equal(result.workspaces.reduce((n, w) => n + w.sessions.length, 0), 2);
    const other = result.locations.find(l => l.kind === "unclassified" && l.path === f.shared)!;
    for (const file of ["huge.jsonl", "future.jsonl", "broken.jsonl"]) assert.ok(other.items.some(i => i.path.endsWith(file)));
    assert.ok(!JSON.stringify(result).includes("PRIVATE_BODY_SENTINEL"));
  } finally { await f.close(); }
});
test("inaccessible artifact directories report incomplete lower bounds", { skip: typeof process.getuid !== "function" || process.getuid() === 0 }, async () => {
  const f = await fixture(), blocked = join(f.shared, "subagent-artifacts", "outputs");
  try {
    await chmod(blocked, 0);
    const result = await scanInventory(f.p, [f.root], f.options);
    const l = result.locations.find(l => l.path.endsWith("subagent-artifacts"))!;
    assert.ok(l.partial); assert.equal(l.bytes, 5);
    assert.ok(result.diagnostics.some(d => d.path === blocked && d.code === "read-directory"));
  } finally { await chmod(blocked, 0o700); await f.close(); }
});
test("byte labels distinguish logical bytes from token counts", () => {
  assert.equal(formatBytes(0), "0 B"); assert.equal(formatBytes(1024), "1.0 KiB"); assert.equal(formatBytes(2 * 1024 ** 2), "2.0 MiB");
});
