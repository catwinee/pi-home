/** Read-only, bounded metadata inventory. Never parses conversation bodies or artifact contents. */
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { DiscoveryOptions, Diagnostic } from "./discovery.js";
import type { Paths } from "./store.js";

export interface SessionRef { path: string; cwd: string; bytes: number; modified: number; current: boolean }
export interface Workspace { cwd: string; sessions: SessionRef[]; bytes: number; modified: number; storageDirs: string[] }
export interface Footprint {
  files: number; directories: number; bytes: number; modified: number;
  symlinks: number; special: number; partial: boolean;
}
export interface InventoryItem extends Footprint { path: string; kind: "file" | "directory" | "symlink" | "other" }
export type LocationKind = "sessions" | "artifacts" | "cache" | "trash" | "unclassified";
export interface InventoryLocation extends Footprint {
  id: string; path: string; kind: LocationKind; cwds: string[]; evidence: string;
  items: InventoryItem[]; itemCount: number; notes: string[];
}
export interface Inventory {
  workspaces: Workspace[]; locations: InventoryLocation[]; diagnostics: Diagnostic[];
  partial: boolean; visited: number; durationMs: number; scannedAt: number; limits: InventoryLimits; scope: string[];
}
export interface InventoryLimits { entries: number; depth: number; milliseconds: number; items: number }
export interface InventoryOptions extends DiscoveryOptions {
  cwd: string; sessionDir?: string; sessionFile?: string; signal?: AbortSignal;
  limits?: Partial<InventoryLimits>;
  /** Explicit known pi-subagents temp root; undefined omits temp inventory (no /tmp glob). */
  tempRoot?: string;
}
const defaults: InventoryLimits = { entries: 20000, depth: 6, milliseconds: 5000, items: 100 };
const empty = (): Footprint => ({ files: 0, directories: 0, bytes: 0, modified: 0, symlinks: 0, special: 0, partial: false });
function add(to: Footprint, from: Footprint): void {
  for (const key of ["files", "directories", "bytes", "symlinks", "special"] as const) to[key] += from[key];
  to.modified = Math.max(to.modified, from.modified); to.partial ||= from.partial;
}
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"]; let n = bytes / 1024, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 10 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
}
/** Matches pi-subagents' default UID-scoped layout; never enumerates the whole temp directory. */
export function subagentTempRoot(): string | undefined {
  const custom = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  if (custom) return resolve(custom);
  return typeof process.getuid === "function" ? join(tmpdir(), `pi-subagents-uid-${process.getuid()}`) : undefined;
}

export async function scanInventory(p: Paths, roots: string[], options: InventoryOptions): Promise<Inventory> {
  const started = performance.now(), limits = { ...defaults, ...options.limits };
  for (const key of Object.keys(defaults) as (keyof InventoryLimits)[]) {
    if (!Number.isFinite(limits[key]) || limits[key] < 1) limits[key] = defaults[key];
    limits[key] = Math.floor(limits[key]);
  }
  let visited = 0, partial = false;
  const diagnostics: Diagnostic[] = [], locations: InventoryLocation[] = [];
  const workspaces = new Map<string, Workspace>();
  const storage = new Map<string, { cwds: Set<string>; sessions: InventoryItem[]; other: InventoryItem[]; partial: boolean }>();
  const checkedDirs = new Set<string>(), blockedDirs = new Set<string>(), walked = new Map<string, number>();
  const seenSessions = new Set<string>(), measured = new Set<string>();
  const candidates = new Map<string, { kind: LocationKind; evidence: string; cwds?: string[]; storageDir?: string }>();
  const grouped = new Set((options.groupedRoots ?? []).map(x => resolve(x)));
  const recursive = new Set((options.recursiveRoots ?? []).map(x => resolve(x)));
  function abort(): void { options.signal?.throwIfAborted(); }
  function room(): boolean {
    abort();
    if (visited >= limits.entries || performance.now() - started >= limits.milliseconds) { partial = true; return false; }
    return true;
  }
  function warn(path: string, code: string, message: string): void {
    partial = true;
    if (diagnostics.length < 100) diagnostics.push({ level: "warning", path, code, message });
  }
  function workspace(cwd: string): Workspace {
    let w = workspaces.get(cwd);
    if (!w) { w = { cwd, sessions: [], bytes: 0, modified: 0, storageDirs: [] }; workspaces.set(cwd, w); }
    return w;
  }
  function stored(dir: string) {
    let s = storage.get(dir);
    if (!s) { s = { cwds: new Set<string>(), sessions: [], other: [], partial: false }; storage.set(dir, s); }
    return s;
  }
  // Reject stable symlinks in any ancestor, not just the final entry. This is not an OS sandbox:
  // concurrent external renames can still race checks. Inventory does not authorize deletion.
  async function safeDir(dir: string): Promise<boolean> {
    if (blockedDirs.has(dir)) return false;
    if (checkedDirs.has(dir)) return true;
    try {
      if (await realpath(dir) !== resolve(dir) || !(await lstat(dir)).isDirectory()) {
        blockedDirs.add(dir); warn(dir, "symlink-or-directory", "Directory is symlinked or not a regular directory; not traversed."); return false;
      }
      checkedDirs.add(dir); return true;
    } catch (e: any) {
      blockedDirs.add(dir);
      if (e.code !== "ENOENT") warn(dir, "directory", `Cannot inspect directory (${e.code || "error"}).`);
      return false;
    }
  }
  async function statItem(path: string): Promise<InventoryItem | undefined> {
    if (!room()) return undefined;
    visited++;
    try {
      const s = await lstat(path);
      const kind = s.isSymbolicLink() ? "symlink" : s.isFile() ? "file" : s.isDirectory() ? "directory" : "other";
      return { ...empty(), path, kind, files: kind === "file" ? 1 : 0, directories: kind === "directory" ? 1 : 0,
        bytes: kind === "file" ? s.size : 0, modified: s.mtimeMs, symlinks: kind === "symlink" ? 1 : 0, special: kind === "other" ? 1 : 0 };
    } catch (e: any) {
      if (e.code !== "ENOENT") warn(path, "stat", `Cannot read file metadata (${e.code || "error"}).`);
      else warn(path, "changed", "Entry disappeared during the scan; snapshot is incomplete.");
      return undefined;
    }
  }
  async function each(dir: string, visit: (path: string, name: string) => Promise<void>): Promise<boolean> {
    if (!room() || !await safeDir(dir)) return false;
    try {
      for await (const entry of await opendir(dir)) {
        if (!room()) return false;
        await visit(join(dir, entry.name), entry.name);
      }
      return true;
    } catch (e: any) {
      abort(); warn(dir, "read-directory", `Cannot finish directory listing (${e.code || "error"}).`);
      return false;
    }
  }
  async function sessionCwd(path: string): Promise<string | undefined> {
    // Only the first JSONL line, max 64 KiB. No body/content extraction, cache creation or migration.
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      if (!(await handle.stat()).isFile()) return undefined;
      let offset = 0, ended = false; const chunks: Buffer[] = [];
      while (offset < 64 * 1024 && room()) {
        const chunk = Buffer.alloc(1024), { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        if (!bytesRead) { ended = true; break; }
        const part = chunk.subarray(0, bytesRead), newline = part.indexOf(10);
        chunks.push(newline < 0 ? part : part.subarray(0, newline)); offset += bytesRead;
        if (newline >= 0) { ended = true; break; }
      }
      if (!ended) return undefined;
      const text = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
      const h = JSON.parse(text);
      if (h?.type !== "session" || ![1, 2, 3].includes(h.version ?? 1) || typeof h.id !== "string" || !h.id || !Number.isFinite(Date.parse(h.timestamp))) return undefined;
      return typeof h.cwd === "string" ? h.cwd : "unknown";
    } finally { await handle.close(); }
  }
  function artifact(dir: string): void {
    candidates.set(join(dir, "subagent-artifacts"), { kind: "artifacts", storageDir: dir,
      evidence: "Known pi-subagents session-storage layout; association is directory-level, not proof of file ownership." });
  }
  async function discover(dir: string, depth: number): Promise<void> {
    dir = resolve(dir);
    if (dir === p.home || dir.startsWith(p.home + sep) || (walked.get(dir) ?? -1) >= depth || !room() || !await safeDir(dir)) return;
    walked.set(dir, depth); stored(dir); artifact(dir);
    const complete = await each(dir, async (path, name) => {
      const item = await statItem(path); if (!item) { stored(dir).partial = true; return; }
      if (item.kind === "directory") {
        if (name === "subagent-artifacts") return; // metadata census separately; no header reads in transcripts
        if (depth > 0) await discover(path, depth - 1);
        else { item.partial = true; stored(dir).other.push(item); }
      } else if (item.kind === "file" && name.endsWith(".jsonl")) {
        if (seenSessions.has(path)) return;
        seenSessions.add(path);
        let cwd: string | undefined;
        try { cwd = await sessionCwd(path); } catch (e: any) {
          abort();
          if (!(e instanceof SyntaxError)) warn(path, "header", `Cannot read session header (${e.code || "error"}).`);
        }
        if (cwd === undefined) { stored(dir).other.push(item); return; }
        const w = workspace(cwd);
        w.sessions.push({ path, cwd, bytes: item.bytes, modified: item.modified, current: path === options.sessionFile });
        w.bytes += item.bytes; w.modified = Math.max(w.modified, item.modified);
        if (!w.storageDirs.includes(dir)) w.storageDirs.push(dir);
        const s = stored(dir); s.cwds.add(cwd); s.sessions.push(item);
      } else stored(dir).other.push(item);
    });
    stored(dir).partial ||= !complete;
  }
  workspace(options.cwd);
  if (options.sessionDir) {
    const dir = resolve(options.sessionDir); stored(dir).cwds.add(options.cwd);
    workspace(options.cwd).storageDirs.push(dir);
  }
  for (const root of new Set([...roots, ...(options.recursiveRoots ?? [])].map(x => resolve(x)))) {
    if (!room()) break;
    await discover(root, recursive.has(root) ? limits.depth : grouped.has(root) ? 1 : 0);
  }
  // Overlapping configured roots may have since traversed a previously unclassified directory.
  for (const [dir, s] of storage) {
    const make = (kind: LocationKind, items: InventoryItem[], evidence: string) => {
      if (!items.length) return;
      items = [...new Map(items.map(item => [item.path, item])).values()];
      const location: InventoryLocation = { ...empty(), partial: s.partial, id: `${kind}:${dir}`, path: dir, kind, cwds: [...s.cwds].sort(), evidence,
        items, itemCount: items.length, notes: [] };
      for (const item of items) add(location, item);
      if (kind === "unclassified") location.notes.push("Unrecognized files are not garbage. Directory contents here were NOT scanned; their sizes are unknown.");
      locations.push(location);
    };
    make("sessions", s.sessions, "Valid first-line Pi session headers. Sizes are logical file bytes; transcript bodies were not parsed.");
    make("unclassified", s.other.filter(item => item.kind !== "directory" || !walked.has(item.path)), "Other entries inside explicitly configured session storage; metadata only, no content inspection.");
  }
  // Only this live cwd's explicit plugin subdirectories are probed. Historical cwd strings do not
  // authorize filesystem traversal. Other project trees, arbitrary /tmp outputs and custom paths are out of scope.
  for (const name of ["artifacts", "chain-runs"]) candidates.set(join(resolve(options.cwd), ".pi", "subagents", name), {
    kind: "artifacts", cwds: [options.cwd], evidence: "Known pi-subagents project layout under the current cwd only; not a disposable-file classification." });
  if (options.tempRoot) for (const name of ["artifacts", "chain-runs", "async-subagent-runs", "async-subagent-results"]) candidates.set(join(resolve(options.tempRoot), name), {
    kind: "artifacts", cwds: [], evidence: "Known pi-subagents user-scoped temp layout; shared across workspaces, NOT attributed to the current cwd." });
  candidates.set(p.cache, { kind: "cache", cwds: [], evidence: "pi-home's shared derived index. Metadata only; not charged to any workspace." });
  candidates.set(p.trash, { kind: "trash", cwds: [], evidence: "pi-home's recoverable session trash. Not a disposable cache; deleting it would lose recovery copies." });
  async function measure(item: InventoryItem, depth: number): Promise<InventoryItem> {
    if (item.kind !== "directory") return item;
    if (depth >= limits.depth || !room() || !await safeDir(item.path)) { item.partial = true; return item; }
    const complete = await each(item.path, async path => {
      const child = await statItem(path);
      if (child) add(item, await measure(child, depth + 1)); else item.partial = true;
    });
    if (!complete || !room()) item.partial = true;
    return item;
  }
  for (const [path, spec] of candidates) {
    if (!room()) break;
    if (measured.has(path)) continue;
    measured.add(path);
    // Do not even lstat a candidate through a symlinked ancestor.
    if (!await safeDir(dirname(path))) continue;
    let exists: boolean;
    try { await lstat(path); exists = true; } catch (e: any) {
      exists = false; if (e.code !== "ENOENT") warn(path, "candidate", `Cannot inspect known location (${e.code || "error"}).`);
    }
    if (!exists) continue;
    const root = await statItem(path); if (!root) break;
    const location: InventoryLocation = { ...root, id: `${spec.kind}:${path}`, path, kind: spec.kind,
      cwds: spec.storageDir ? [...(storage.get(spec.storageDir)?.cwds ?? [])].sort() : spec.cwds ?? [],
      evidence: spec.evidence, items: [], itemCount: 0, notes: [] };
    if (root.kind === "directory") {
      if (!await safeDir(path)) location.partial = true;
      else {
        const complete = await each(path, async path => {
          const item = await statItem(path);
          if (item) { await measure(item, 1); add(location, item); location.items.push(item); location.itemCount++; }
          else location.partial = true;
        });
        location.partial ||= !complete;
      }
      if (!room()) location.partial = true;
    } else location.items.push(root);
    if (root.kind !== "directory") location.itemCount = 1;
    if (root.kind === "symlink") location.notes.push("Symlink target was not visited or measured.");
    if (location.symlinks || location.special) location.notes.push("Symlinks and special files are counted but never followed/read; no bytes are attributed to their targets.");
    if (location.partial) location.notes.push("Incomplete census: displayed file counts and bytes are lower bounds, not a complete total.");
    locations.push(location);
  }
  for (const location of locations) {
    location.items.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
    if (location.items.length > limits.items) {
      location.items = location.items.slice(0, limits.items);
      location.notes.push(`Showing largest ${limits.items} of ${location.itemCount} direct entries. Aggregate counts include other inspected entries.`);
    }
    if (location.cwds.length > 1) location.notes.push("Shared storage: associated with multiple cwd values. Do not add this size once per workspace.");
  }
  if (partial && diagnostics.length < 100) diagnostics.push({ level: "warning", code: "partial-inventory", path: p.agentDir,
    message: "Snapshot is incomplete (scan budget, changing files or inaccessible paths). Missing locations are not evidence of absence; refresh to retry." });
  return { workspaces: [...workspaces.values()].sort((a, b) => b.modified - a.modified || a.cwd.localeCompare(b.cwd)),
    locations: locations.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path)), diagnostics,
    partial: partial || locations.some(l => l.partial), visited, durationMs: performance.now() - started, scannedAt: Date.now(), limits,
    scope: [...new Set(roots.map(root => `Session headers: ${resolve(root)}`)), ...[...candidates.keys()].map(path => `Known location: ${path}`)] };
}
