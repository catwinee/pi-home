import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { atomicJson, isSession, parseSessionText, type Session } from "./stats.js";
import type { Diagnostic, DiscoveryOptions } from "./discovery.js";

export interface Config { startup: boolean; sessionRoots: string[]; recursiveSessionRoots?: string[] }
export interface Identity { size: number; mtimeMs: number; ino: number; dev: number }
export interface Ticket { path: string; identity: Identity; session: Session }
export interface TrashRecord { id: string; original: string; deletedAt: number; session: Session; identity: Identity }
export function paths(agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")) {
  const home = join(resolve(agentDir), "pi-home");
  return { agentDir: resolve(agentDir), home, cache: join(home, "cache.json"), config: join(home, "config.json"), trash: join(home, "trash"), leases: join(home, "active") };
}
export type Paths = ReturnType<typeof paths>;
export async function loadConfig(p: Paths): Promise<Config> {
  try {
    const c = JSON.parse(await readFile(p.config, "utf8"));
    const roots = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && isAbsolute(v)) : [];
    return { startup: c.startup !== false, sessionRoots: roots(c.sessionRoots), recursiveSessionRoots: roots(c.recursiveSessionRoots) };
  } catch { return { startup: true, sessionRoots: [] }; }
}
export function sessionRoots(p: Paths, config: Config, currentDir?: string): string[] {
  return [...new Set([join(p.agentDir, "sessions"), process.env.PI_CODING_AGENT_SESSION_DIR, ...config.sessionRoots, ...(config.recursiveSessionRoots ?? []), currentDir].filter((v): v is string => !!v).map(v => resolve(v)))];
}
const inside = (parent: string, child: string) => { const rel = relative(parent, child); return rel === "" || (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !isAbsolute(rel)); };
const identity = (s: Identity): Identity => ({ size: s.size, mtimeMs: s.mtimeMs, ino: s.ino, dev: s.dev });
const same = (a: Identity, b: Identity) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev;
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code !== "ESRCH"; }
}

/** Cooperative protection, not a lock on Pi itself. Other Pi installations may not participate. */
export class ActiveLease {
  private file: string;
  constructor(p: Paths) { this.file = join(p.leases, `${process.pid}-${randomUUID()}.json`); }
  async set(path?: string): Promise<void> {
    if (!path) return this.close();
    await atomicJson(this.file, { pid: process.pid, path: resolve(path) });
  }
  async close(): Promise<void> { await rm(this.file, { force: true }); }
}
export async function activePaths(p: Paths): Promise<Set<string>> {
  const out = new Set<string>();
  let entries: string[];
  try { entries = await readdir(p.leases); } catch (e: any) { if (e.code === "ENOENT") return out; throw e; }
  for (const f of entries.filter(f => f.endsWith(".json"))) {
    const path = join(p.leases, f);
    let lease: any;
    try { lease = JSON.parse(await readFile(path, "utf8")); }
    catch (e: any) { if (e.code === "ENOENT") continue; throw new Error("Cannot verify active-session registry; retry later"); }
    if (!lease || !Number.isInteger(lease.pid) || lease.pid <= 0 || typeof lease.path !== "string" || !isAbsolute(lease.path))
      throw new Error("Invalid active-session registry; cleanup is blocked until repaired");
    if (alive(lease.pid)) { out.add(resolve(lease.path)); }
    else await rm(path, { force: true });
  }
  return out;
}

export class TrashStore {
  readonly discovery: DiscoveryOptions;
  constructor(readonly p: Paths, readonly roots: string[], recursiveRoots: string[] = []) {
    this.discovery = { groupedRoots: [join(p.agentDir, "sessions")], recursiveRoots };
  }
  private async allowed(path: string): Promise<string> {
    path = resolve(path);
    if (!path.endsWith(".jsonl")) throw new Error("Not a session JSONL file");
    if (inside(this.p.home, path)) throw new Error("Managed data is not a live session");
    const canonical = await realpath(path);
    if (canonical !== path) throw new Error("Symlinked sessions cannot be deleted");
    if (!this.roots.some(root => inside(resolve(root), path))) throw new Error("Session is outside configured roots");
    if (!(await lstat(path)).isFile()) throw new Error("Not a regular session file");
    return path;
  }
  async prepare(path: string): Promise<Ticket> {
    path = await this.allowed(path);
    const before = identity(await lstat(path));
    const session = parseSessionText(await readFile(path, "utf8"), path);
    const after = identity(await lstat(path));
    if (session.pendingTail) throw new Error("Session has an incomplete final record; wait for the writer and inspect again");
    if (!same(before, after)) throw new Error("Session changed while reading; inspect again");
    return { path, identity: after, session };
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.p.home, { recursive: true, mode: 0o700 });
    const lock = join(this.p.home, "trash.lock");
    // Do not auto-break a lock: a crash is uncommon, and manual recovery is safer than a race.
    try { await writeFile(lock, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 }); }
    catch (e: any) { if (e.code === "EEXIST") throw new Error(`Another cleanup is running (or stale lock: ${lock}); see README`); throw e; }
    try { return await fn(); } finally { await unlink(lock); }
  }
  async move(ticket: Ticket, currentPath?: string): Promise<TrashRecord> {
    return this.exclusive(async () => {
      const path = await this.allowed(ticket.path);
      if (currentPath && resolve(currentPath) === path) throw new Error("Leave the current session before deleting it");
      if ((await activePaths(this.p)).has(path)) throw new Error("Session is active in a Pi instance running pi-home");
      if (!same(ticket.identity, await lstat(path))) throw new Error("Session changed since confirmation; inspect it again");
      const id = randomUUID(), folder = join(this.p.trash, id), target = join(folder, "session.jsonl");
      const record: TrashRecord = { id, original: path, deletedAt: Date.now(), identity: ticket.identity,
        session: { ...ticket.session, documents: [], trashed: id } };
      await mkdir(folder, { recursive: true, mode: 0o700 });
      // Durable metadata first. An interrupted pre-move record has no payload and is ignored.
      await atomicJson(join(folder, "record.json"), record);
      try { await rename(path, target); }
      catch (e) { await rm(folder, { recursive: true, force: true }); throw e; }
      if (!same(ticket.identity, await lstat(target))) {
        // An uncooperative writer raced the move. Restore without ever overwriting a new file.
        try { await link(target, path); await unlink(target); await rm(folder, { recursive: true, force: true }); }
        catch { throw new Error(`Concurrent write detected. Recovery copy preserved in ${folder}; original path may have been recreated.`); }
        throw new Error("Concurrent write detected; deletion rolled back");
      }
      return record;
    });
  }
  async inspect(): Promise<{ records: TrashRecord[]; diagnostics: Diagnostic[] }> {
    let dirs: string[];
    const records: TrashRecord[] = [], diagnostics: Diagnostic[] = [];
    try { dirs = await readdir(this.p.trash); }
    catch (e: any) {
      if (e.code !== "ENOENT") diagnostics.push({ level: "warning", code: "read-trash", path: this.p.trash, message: e.message });
      return { records, diagnostics };
    }
    for (const id of dirs.filter(v => /^[a-f0-9-]{36}$/.test(v))) {
      const folder = join(this.p.trash, id);
      try {
        if (!(await lstat(folder)).isDirectory()) throw new Error("Trash directory is not a regular directory");
        const payload = await lstat(join(folder, "session.jsonl")).catch((e: any) => { if (e.code === "ENOENT") return undefined; throw e; });
        if (!payload) { diagnostics.push({ level: "info", code: "incomplete-trash", path: folder, message: "No payload: interrupted move/restore; no data counted or removed." }); continue; }
        if (!payload.isFile()) throw new Error("Trash payload is not a regular file");
        if (!(await lstat(join(folder, "record.json"))).isFile()) throw new Error("Trash metadata is not a regular file");
        const r = JSON.parse(await readFile(join(folder, "record.json"), "utf8"));
        if (r.id !== id || typeof r.original !== "string" || !isAbsolute(r.original) || !Number.isFinite(r.deletedAt)
          || !isSession(r.session) || r.session.path !== r.original || r.session.trashed !== id
          || ![r.identity?.ino, r.identity?.dev, r.identity?.size, r.identity?.mtimeMs].every(Number.isFinite)) throw new Error("Invalid record; original payload retained for manual recovery");
        if (!same(r.identity, payload)) throw new Error("Trash payload changed since deletion; retained for manual recovery");
        records.push(r);
      } catch (e: any) { diagnostics.push({ level: "warning", code: "invalid-trash", path: folder, message: e.message }); }
    }
    return { records: records.sort((a, b) => b.deletedAt - a.deletedAt), diagnostics };
  }
  async list(): Promise<TrashRecord[]> {
    const { records, diagnostics } = await this.inspect();
    const warning = diagnostics.find(d => d.level === "warning");
    if (warning) throw new Error(`Unreadable trash record ${warning.path}: ${warning.message}`);
    return records;
  }
  async restore(id?: string): Promise<string> {
    return this.exclusive(async () => {
      const records = await this.list(), record = id ? records.find(r => r.id === id) : records[0];
      if (!record) throw new Error("Nothing to restore");
      if (!this.roots.some(root => inside(resolve(root), record.original)) || inside(this.p.home, record.original)) throw new Error("Original location is outside configured session roots");
      if ((await activePaths(this.p)).has(record.original)) throw new Error("Original location is in use");
      const folder = join(this.p.trash, record.id), payload = join(folder, "session.jsonl");
      await mkdir(dirname(record.original), { recursive: true, mode: 0o700 });
      if (await realpath(dirname(record.original)) !== dirname(record.original)) throw new Error("Original directory became a symlink");
      // link() atomically refuses an existing destination. No overwrite, even under concurrency.
      try { await link(payload, record.original); }
      catch (e: any) {
        if (e.code !== "EEXIST") throw e;
        const existing = await lstat(record.original), saved = await lstat(payload);
        // Resume an interrupted restore only when both names refer to the same exact file.
        if (!existing.isFile() || !same(existing, saved)) throw e;
      }
      await unlink(payload);
      await rm(folder, { recursive: true, force: true });
      return record.original;
    });
  }
  async read(record: TrashRecord): Promise<Session> {
    const s = parseSessionText(await readFile(join(this.p.trash, record.id, "session.jsonl"), "utf8"), record.original);
    s.trashed = record.id; return s;
  }
}
