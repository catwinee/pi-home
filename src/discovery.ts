import { lstat, open, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export interface Diagnostic {
  level: "info" | "warning";
  code: string;
  path: string;
  message: string;
}
export interface DiscoveryOptions {
  /** Pi's default storage contains one cwd directory level. Custom --session-dir is flat. */
  groupedRoots?: string[];
  /** Only explicitly opted-in roots recurse into arbitrary plugin layouts. */
  recursiveRoots?: string[];
}
export interface Discovery {
  files: string[];
  diagnostics: Diagnostic[];
  excludedDirectories: number;
}
export async function listSessionFiles(roots: string[], options: DiscoveryOptions = {}): Promise<Discovery> {
  const visited = new Map<string, number>(), files = new Set<string>(), diagnostics: Diagnostic[] = [];
  const grouped = new Set(options.groupedRoots?.map(p => resolve(p)));
  const recursive = new Set(options.recursiveRoots?.map(p => resolve(p)));
  const excluded = new Set<string>();
  async function walk(dir: string, depth: number): Promise<void> {
    dir = resolve(dir);
    if ((visited.get(dir) ?? -1) >= depth) return;
    visited.set(dir, depth); excluded.delete(dir);
    try {
      if (!(await lstat(dir)).isDirectory()) {
        diagnostics.push({ level: "warning", code: "root-not-directory", path: dir, message: "Root is not a regular directory (symlinks are not followed)." }); return;
      }
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (depth > 0) await walk(p, depth - 1);
          else if (!visited.has(p)) excluded.add(p);
        } else if (e.isFile() && e.name.endsWith(".jsonl")) files.add(p);
      }
    } catch (e: any) {
      diagnostics.push({ level: e.code === "ENOENT" ? "info" : "warning", code: e.code === "ENOENT" ? "missing-root" : "read-directory", path: dir, message: e.message });
    }
  }
  for (const root of [...new Set([...roots, ...(options.recursiveRoots ?? [])].map(p => resolve(p)))])
    await walk(root, recursive.has(root) ? Infinity : grouped.has(root) ? 1 : 0);
  return { files: [...files].sort(), diagnostics, excludedDirectories: excluded.size };
}

export type HeaderKind = "session" | "non-session" | "invalid" | "pending" | "unsupported";
export interface HeaderProbe { kind: HeaderKind; message: string }
const NATIVE_FILENAME = /^\d{4}-\d{2}-\d{2}T.*_.+\.jsonl$/;
/** Read at most 64 KiB, not the body of arbitrary plugin artifacts. */
export async function probeSessionHeader(path: string, known = false): Promise<HeaderProbe> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8").replace(/^\uFEFF/, "");
    const line = text.split(/\r?\n/).find(l => l.trim())?.trim() || "";
    const expected = known || basename(path) === "session.jsonl" || NATIVE_FILENAME.test(basename(path));
    if (!line) return { kind: "pending", message: "Empty file; may not have been flushed yet." };
    let header: any;
    try { header = JSON.parse(line); }
    catch {
      const resemblesSession = /"type"\s*:\s*"session"/.test(line);
      if (!text.includes("\n") && bytesRead < buffer.length)
        return { kind: "pending", message: "Incomplete first record; retry after the writer finishes." };
      return { kind: expected || resemblesSession ? "invalid" : "non-session", message: "No readable session header within the first record (64 KiB probe limit)." };
    }
    if (header?.type !== "session") return { kind: expected ? "invalid" : "non-session", message: expected ? "Expected a Pi session, but its first record has no session header." : "JSONL artifact, not a Pi session." };
    if (typeof header.id !== "string" || !header.id || !Number.isFinite(Date.parse(header.timestamp)))
      return { kind: "invalid", message: "Session header has an invalid ID or timestamp." };
    const version = header.version ?? 1;
    if (![1, 2, 3].includes(version)) return { kind: "unsupported", message: `Unsupported session version ${String(version)}; not parsed or modified.` };
    return { kind: "session", message: "" };
  } finally { await handle.close(); }
}
