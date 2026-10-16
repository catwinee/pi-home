// Derived from pi-stats-ext (MIT). See NOTICE.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, lstat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { runCooperatively, runSync } from "./cooperative.js";
import { listSessionFiles, probeSessionHeader, type Diagnostic, type DiscoveryOptions } from "./discovery.js";
export { listSessionFiles } from "./discovery.js";

export interface Totals {
  input: number; output: number; cacheRead: number; cacheWrite: number; cost: number;
  users: number; assistants: number; tools: number; nestedTools: number; errors: number;
  unknownUsage: number; incompleteNested: number;
}
export interface Event extends Totals {
  key: string; timestamp: number; provider: string; model: string;
  toolNames: string[]; nestedNames: string[];
}
export interface Document {
  id: string; role: string; timestamp: number; text: string; extra: string;
}
export interface Session {
  path: string; id: string; name: string; cwd: string; parent?: string;
  created: number; modified: number; events: Event[]; documents: Document[];
  warnings: number; pendingTail?: boolean; trashed?: string;
}
export interface CachedFile { mtimeMs: number; size: number; ino: number; session: Session }
export interface Cache { version: 2; files: Record<string, CachedFile>; knownPaths?: string[] }
export interface Range { label: string; start?: number; end?: number }
export interface Bucket extends Totals { key: string; sessions: Set<string> }
export interface Stats {
  totals: Totals; newSessions: number; activeSessions: number;
  daily: Map<string, Totals>; models: Bucket[]; projects: Bucket[]; tools: Bucket[];
}
export interface Scan {
  cache: Cache; sessions: Session[]; errors: string[]; diagnostics: Diagnostic[]; reused: number;
  skipped: number; pending: number; excludedDirectories: number; durationMs: number;
}

export const emptyTotals = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
  users: 0, assistants: 0, tools: 0, nestedTools: 0, errors: 0, unknownUsage: 0, incompleteNested: 0 });
export const emptyCache = (): Cache => ({ version: 2, files: {} });
export function addTotals(target: Totals, source: Totals): void {
  for (const key of Object.keys(target) as (keyof Totals)[]) if (typeof target[key] === "number") target[key] += source[key] || 0;
}
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function parseDay(s: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = new Date(`${s}T00:00:00`);
  return Number.isFinite(+d) && dayKey(+d) === s ? +d : undefined;
}
export function shiftDay(ts: number, days: number): number {
  const d = new Date(ts); d.setDate(d.getDate() + days); return +d;
}
export function parseRange(input = "today", now = Date.now()): Range {
  const s = input.trim().toLowerCase();
  if (s === "all") return { label: "all" };
  const days = ({ today: 1, "7d": 7, "30d": 30, "90d": 90 } as Record<string, number>)[s];
  const midnight = parseDay(dayKey(now))!;
  if (days) return { label: s, start: shiftDay(midnight, 1 - days), end: shiftDay(midnight, 1) };
  const parts = s.split("..");
  const start = parseDay(parts[0] || ""), end = parseDay(parts[1] || "");
  if (parts.length === 2 && start !== undefined && end !== undefined && end >= start)
    return { label: s, start, end: shiftDay(end, 1) };
  throw new Error("Range: today, 7d, 30d, 90d, all, or YYYY-MM-DD..YYYY-MM-DD");
}
export const inRange = (ts: number, r: Range): boolean => Number.isFinite(ts) && ts > 0 && (r.start === undefined || ts >= r.start) && (r.end === undefined || ts < r.end);
export function formatTokens(n: number): string {
  const trim = (v: number) => v >= 10 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "");
  return n >= 1e6 ? `${trim(n / 1e6)}M` : n >= 1e3 ? `${trim(n / 1e3)}k` : String(Math.round(n));
}
export const formatCost = (n: number): string => n === 0 ? "$0" : n < .01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
export const tokenTotal = (t: Totals): number => t.input + t.output + t.cacheRead + t.cacheWrite;

// Never replay terminal controls from persisted model/tool text (OSC, CSI, C0/C1).
export function safeText(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "").replace(/\t/g, "    ");
}
export const safeLabel = (text: string): string => safeText(text).replace(/\s+/g, " ").trim();
function content(value: any): { text: string; extra: string } {
  if (typeof value === "string") return { text: safeText(value), extra: "" };
  const text: string[] = [], extra: string[] = [];
  if (Array.isArray(value)) for (const b of value) {
    if (b?.type === "text" && typeof b.text === "string") text.push(b.text);
    else if (b?.type === "thinking") extra.push(`[thinking]\n${b.thinking || ""}`);
    else if (b?.type === "toolCall") extra.push(`[tool: ${b.name}]\n${JSON.stringify(b.arguments ?? {})}`);
    else if (b?.type === "image") text.push(`[image: ${b.mimeType || "unknown"}; open in Pi to view]`);
  }
  return { text: safeText(text.join("\n")), extra: safeText(extra.join("\n\n")) };
}
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
const timestamp = (v: unknown): number => typeof v === "number" ? (Number.isFinite(v) ? v : 0) : typeof v === "string" ? Date.parse(v) || 0 : 0;

export function parseSessionText(raw: string, path: string): Session {
  return runSync(parseSessionSteps(raw, path));
}
function* parseSessionSteps(raw: string, path: string): Generator<void, Session> {
  const s: Session = { path: resolve(path), id: basename(path, ".jsonl"), name: "", cwd: "unknown", created: 0, modified: 0, events: [], documents: [], warnings: 0 };
  let header = false, firstUser = "";
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    yield;
    const line = lines[i]!; if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch {
      if (header && i === lines.length - 1 && !raw.endsWith("\n")) s.pendingTail = true;
      else s.warnings++;
      continue;
    }
    if (!e || typeof e !== "object") { s.warnings++; continue; }
    if (!header) {
      if (e.type !== "session") throw new Error("Missing session header");
      if (typeof e.id !== "string" || !e.id || !timestamp(e.timestamp)) throw new Error("Invalid session header");
      if (![1, 2, 3].includes(e.version ?? 1)) throw new Error("Unsupported session version");
      header = true; s.id = safeLabel(String(e.id || s.id)); s.cwd = typeof e.cwd === "string" ? e.cwd : "unknown";
      s.created = timestamp(e.timestamp);
      if (typeof e.parentSession === "string") s.parent = resolve(dirname(s.path), e.parentSession);
      continue;
    }
    if (e.type === "session_info") { s.name = typeof e.name === "string" ? safeLabel(e.name) : ""; continue; }
    const m = e.type === "message" ? e.message : undefined;
    if (m?.role === "system") continue;
    const summary = e.type === "compaction" || e.type === "branch_summary";
    const hasUsage = e.type === "usage" || summary || m?.role === "toolResult" || m?.role === "assistant";
    const ts = timestamp(m?.timestamp) || timestamp(e.timestamp);
    if (m || summary || e.type === "custom_message") {
      const body = content(m?.content ?? e.content ?? e.summary);
      const role = String(m?.role || e.type);
      if (role === "user" && !firstUser) firstUser = body.text.replace(/\s+/g, " ").slice(0, 100);
      if (role === "bashExecution") body.text = safeText(`${m.command || ""}\n${m.output || ""}`);
      s.documents.push({ id: safeLabel(String(e.id || i)), timestamp: ts, role: safeLabel(role), ...body });
    }
    if (!m && !hasUsage) continue;
    const usage = m?.usage ?? e.usage;
    const t = emptyTotals();
    if (m?.role === "user") t.users = 1;
    if (m?.role === "assistant") t.assistants = 1;
    const toolNames = Array.isArray(m?.content) ? m.content.filter((b: any) => b?.type === "toolCall").map((b: any) => safeText(String(b.name || "unknown"))) : [];
    const nestedNames = Array.isArray(m?.nestedCalls?.calls) ? m.nestedCalls.calls.map((c: any) => safeText(String(c?.name || "unknown"))) : [];
    t.tools = toolNames.length; t.nestedTools = nestedNames.length;
    t.errors = m?.role === "toolResult" && m.isError ? 1 : 0;
    t.incompleteNested = m?.nestedCalls?.complete === false ? 1 : 0;
    if (usage && typeof usage === "object") {
      for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) t[k] = num(usage[k]);
      t.cost = num(usage.cost?.total);
      if (!["input", "output", "cacheRead", "cacheWrite"].every(k => typeof usage[k] === "number" && Number.isFinite(usage[k]) && usage[k] >= 0)) t.unknownUsage = 1;
    } else if (m?.role === "assistant" || summary || e.type === "usage") t.unknownUsage = 1;
    // Summaries and nested model work lack physical model attribution in some Pi versions.
    const provider = safeText(String(m?.provider || e.provider || "unattributed"));
    const model = safeText(String(m?.responseModel || m?.model || e.model || "unattributed"));
    // Fork/clone preserve entry IDs and timestamps, but can re-chain parentId.
    // Include the payload to avoid merging short-ID collisions; never hash parentId.
    const payload = m ?? { type: e.type, usage: e.usage, summary: e.summary, kind: e.kind };
    const hash = createHash("sha256").update(JSON.stringify([e.id, ts, payload])).digest("hex");
    const key = typeof e.id === "string" ? hash : `${s.path}:${i}:${hash}`;
    if (ts > 0) s.events.push({ ...t, key, timestamp: ts, provider, model, toolNames, nestedNames });
    else s.warnings++;
    s.modified = Math.max(s.modified, ts || 0);
  }
  if (!header) throw new Error("Missing session header");
  s.name = s.name.trim() || firstUser || s.id;
  s.modified = s.modified || s.created;
  return s;
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await atomicText(path, JSON.stringify(value));
}
async function atomicText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, text, { mode: 0o600, flag: "wx" }); await rename(tmp, path); }
  finally { await rm(tmp, { force: true }); }
}
/** Keep the v2 on-disk format; yield between sessions instead of one giant stringify. */
function* cacheJson(cache: Cache): Generator<void, string> {
  const parts = ['{"version":2,"files":{'];
  let separator = "";
  for (const [path, file] of Object.entries(cache.files)) {
    yield;
    parts.push(separator, JSON.stringify(path), ":", JSON.stringify(file)); separator = ",";
  }
  parts.push('},"knownPaths":', JSON.stringify(cache.knownPaths ?? []), "}");
  yield;
  return parts.join("");
}
export function isSession(s: any): s is Session {
  return !!s && [s.path, s.id, s.name, s.cwd].every(v => typeof v === "string")
    && (s.parent === undefined || typeof s.parent === "string")
    && (s.trashed === undefined || typeof s.trashed === "string")
    && [s.created, s.modified, s.warnings].every(Number.isFinite)
    && Array.isArray(s.events) && Array.isArray(s.documents)
    && s.events.every((e: any) => e && [e.key, e.provider, e.model].every(v => typeof v === "string")
      && Number.isFinite(e.timestamp) && Object.keys(emptyTotals()).every(k => Number.isFinite(e[k]) && e[k] >= 0)
      && [e.toolNames, e.nestedNames].every(v => Array.isArray(v) && v.every(n => typeof n === "string")))
    && s.documents.every((d: any) => d && [d.id, d.text, d.extra, d.role].every(v => typeof v === "string") && Number.isFinite(d.timestamp));
}
export async function loadCache(path: string): Promise<Cache> {
  try { return await runCooperatively(validateCache(JSON.parse(await readFile(path, "utf8")))); }
  catch { return emptyCache(); /* disposable cache */ }
}
function* validateCache(c: any): Generator<void, Cache> {
  if (c?.version !== 2 || !c.files || typeof c.files !== "object" || Array.isArray(c.files)
    || !(c.knownPaths === undefined || (Array.isArray(c.knownPaths) && c.knownPaths.every((p: unknown) => typeof p === "string")))) return emptyCache();
  for (const [path, value] of Object.entries(c.files)) {
    yield;
    const f = value as any, s = f?.session;
    if (![f?.mtimeMs, f?.size, f?.ino].every(Number.isFinite) || !isSession(s) || s.path !== path) return emptyCache();
  }
  return c;
}
const inFlightScans = new Map<string, Promise<Scan>>();
export function refreshCache(roots: string[], cachePath: string, options: DiscoveryOptions = {}): Promise<Scan> {
  const key = JSON.stringify([resolve(cachePath), [...roots].sort(), [...(options.groupedRoots ?? [])].sort(), [...(options.recursiveRoots ?? [])].sort()]);
  const running = inFlightScans.get(key);
  if (running) return running;
  const task = scanCache(roots, cachePath, options).finally(() => { inFlightScans.delete(key); });
  inFlightScans.set(key, task);
  return task;
}
async function scanCache(roots: string[], cachePath: string, options: DiscoveryOptions): Promise<Scan> {
  const started = performance.now();
  const old = await loadCache(cachePath), cache = emptyCache();
  const { files, diagnostics, excludedDirectories } = await listSessionFiles(roots, options);
  let reused = 0, skipped = 0, pending = 0;
  const known = new Set([...(old.knownPaths ?? []), ...Object.keys(old.files)]);
  const reportSession = (s: Session) => {
    if (s.warnings) diagnostics.push({ level: "warning", code: "malformed-entries", path: s.path, message: `${s.warnings} malformed/undated entries skipped; totals may be incomplete.` });
    if (s.pendingTail) { pending++; diagnostics.push({ level: "info", code: "pending-tail", path: s.path, message: "Partial final record ignored; refresh after writing finishes." }); }
  };
  for (const path of files) {
    try {
      const before = await lstat(path);
      if (!before.isFile()) continue;
      const cached = old.files[path];
      if (cached && cached.mtimeMs === before.mtimeMs && cached.size === before.size && cached.ino === before.ino) {
        cache.files[path] = cached; reused++;
        reportSession(cached.session);
        continue;
      }
      const probe = await probeSessionHeader(path, known.has(path));
      if (probe.kind !== "session") {
        if (probe.kind === "pending") pending++;
        else if (probe.kind === "non-session") skipped++;
        diagnostics.push({ level: probe.kind === "invalid" || probe.kind === "unsupported" ? "warning" : "info", code: probe.kind, path, message: probe.message });
        continue;
      }
      const session = await runCooperatively(parseSessionSteps(await readFile(path, "utf8"), path));
      const after = await lstat(path);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error("Session changed during scan; refresh again");
      cache.files[path] = { mtimeMs: after.mtimeMs, size: after.size, ino: after.ino, session };
      known.add(path);
      reportSession(session);
    } catch (err: any) { diagnostics.push({ level: err.code === "ENOENT" ? "info" : "warning", code: "read-session", path, message: err.message }); }
  }
  cache.knownPaths = files.filter(path => known.has(path));
  // Still discover/stat every file and report diagnostics; only skip an identical cache write.
  // Missing/corrupt/legacy caches lack knownPaths and must be rebuilt, even for an empty library.
  const unchanged = old.knownPaths !== undefined && reused === Object.keys(old.files).length
    && reused === Object.keys(cache.files).length && old.knownPaths.length === cache.knownPaths.length
    && old.knownPaths.every((path, i) => path === cache.knownPaths![i]);
  if (!unchanged) try { await atomicText(cachePath, await runCooperatively(cacheJson(cache))); }
  catch (err: any) { diagnostics.push({ level: "warning", code: "write-cache", path: cachePath, message: err.message }); }
  return { cache, sessions: Object.values(cache.files).map(f => f.session), errors: diagnostics.filter(d => d.level === "warning").map(d => `${d.path}: ${d.message}`),
    diagnostics, reused, skipped, pending, excludedDirectories, durationMs: performance.now() - started };
}

export function mergeSessions(live: Session[], trash: Session[]): Session[] {
  if (!trash.length) return [...live];
  // A partially completed restore may leave two names for the same session.
  // A different session recreated at the original path must NOT hide historic usage.
  const keys = new Map(live.map(s => [s.path, { id: s.id, events: new Set(s.events.map(e => e.key)) }]));
  return [...live, ...trash.filter(s => {
    const current = keys.get(s.path);
    return !current || current.id !== s.id || !s.events.every(e => current.events.has(e.key));
  })];
}
export function aggregate(sessions: Session[], range: Range, cwd?: string): Stats {
  return runSync(aggregateSteps(sessions, [range], cwd))[0]!;
}
/** Share lineage/order/dedup across ranges, allowing keyboard and render work between slices. */
export function aggregateCooperatively(sessions: Session[], ranges: Range[], cwd?: string, signal?: AbortSignal): Promise<Stats[]> {
  return runCooperatively(aggregateSteps(sessions, ranges, cwd), signal);
}
function* aggregateSteps(sessions: Session[], ranges: Range[], cwd?: string): Generator<void, Stats[]> {
  const states = ranges.map(range => ({ range, totals: emptyTotals(), daily: new Map<string, Totals>(),
    models: new Map<string, Bucket>(), projects: new Map<string, Bucket>(), tools: new Map<string, Bucket>(),
    active: new Set<string>(), newSessions: 0 }));
  const byPath = new Map(sessions.map(s => [s.path, s])), seen = new Set<string>();
  const root = (s: Session) => {
    const visited = new Set<string>(); let path = s.path;
    while (!visited.has(path)) { visited.add(path); const parent = byPath.get(path)?.parent; if (!parent) break; path = parent; }
    return path;
  };
  const depth = (s: Session) => { let n = 0, p = s, seen = new Set<string>(); while (p.parent && byPath.has(p.parent) && !seen.has(p.path)) { seen.add(p.path); p = byPath.get(p.parent)!; n++; } return n; };
  const roots = new Map<Session, string>(), depths = new Map<Session, number>();
  for (const s of sessions) {
    yield;
    roots.set(s, root(s)); depths.set(s, depth(s));
    for (const state of states) if (inRange(s.created, state.range) && (cwd === undefined || s.cwd === cwd)) state.newSessions++;
  }
  function bucket(map: Map<string, Bucket>, key: string, e: Totals, s: Session) {
    let b = map.get(key); if (!b) { b = { ...emptyTotals(), key, sessions: new Set() }; map.set(key, b); }
    addTotals(b, e); b.sessions.add(s.path);
  }
  // Deduplicate BEFORE date/cwd filtering, attributing inherited entries to their ancestor.
  const ordered = [...sessions].sort((a, b) => depths.get(a)! - depths.get(b)! || a.created - b.created || a.path.localeCompare(b.path));
  for (const s of ordered) for (const e of s.events) {
    yield;
    const key = `${roots.get(s)}:${e.key}`;
    if (seen.has(key)) continue; seen.add(key);
    if (cwd !== undefined && s.cwd !== cwd) continue;
    const day = dayKey(e.timestamp);
    for (const state of states) {
      if (!inRange(e.timestamp, state.range)) continue;
      const { totals, daily, models, projects, tools, active } = state;
      active.add(`${s.path}#${s.id}`); addTotals(totals, e);
      if (!daily.has(day)) daily.set(day, emptyTotals()); addTotals(daily.get(day)!, e);
      bucket(projects, s.cwd, e, s);
      if (e.assistants || tokenTotal(e) || e.unknownUsage || e.cost) bucket(models, `${e.provider}/${e.model}`, e, s);
      for (const name of e.toolNames) bucket(tools, name, { ...emptyTotals(), tools: 1 }, s);
      for (const name of e.nestedNames) bucket(tools, name, { ...emptyTotals(), nestedTools: 1 }, s);
    }
  }
  return states.map(({ totals, daily, newSessions, active, models, projects, tools }) => ({ totals, daily, newSessions, activeSessions: active.size,
    models: [...models.values()].sort((a, b) => tokenTotal(b) - tokenTotal(a)),
    projects: [...projects.values()].sort((a, b) => b.users - a.users || tokenTotal(b) - tokenTotal(a)),
    tools: [...tools.values()].sort((a, b) => b.tools + b.nestedTools - a.tools - a.nestedTools) }));
}

export interface Match { session: Session; snippet: string; document?: number }
const searchCache = new WeakMap<Session, { meta: string; dialogue: string[]; all?: string[] }>();
export function searchSessions(sessions: Session[], query: string, allText = false, cwd?: string): Match[] {
  const terms = (query.match(/"[^"]+"|\S+/g) || []).map(s => s.replace(/^"|"$/g, "").toLocaleLowerCase());
  const candidates = sessions.filter(s => !s.trashed && (cwd === undefined || s.cwd === cwd));
  if (!terms.length) return candidates.map(session => ({ session, snippet: "" })).sort((a, b) => b.session.modified - a.session.modified);
  return candidates.map<Match | undefined>(session => {
    let index = searchCache.get(session);
    if (!index) {
      index = { meta: `${session.name}\n${session.id}\n${session.cwd}`.toLocaleLowerCase(),
        dialogue: session.documents.map(d => ["user", "assistant"].includes(d.role) ? d.text.toLocaleLowerCase() : "") };
      searchCache.set(session, index);
    }
    if (allText && !index.all) index.all = session.documents.map(d => `${d.text}\n${d.extra}`.toLocaleLowerCase());
    const searchable = allText ? index.all! : index.dialogue;
    if (!terms.every(t => index!.meta.includes(t) || searchable.some(d => d.includes(t)))) return undefined;
    const document = searchable.findIndex(d => terms.some(t => d.includes(t)));
    let snippet = "";
    if (document >= 0) {
      const d = session.documents[document]!;
      const text = (allText ? `${d.text}\n${d.extra}` : d.text).replace(/\s+/g, " ");
      const pos = Math.max(0, Math.min(...terms.map(t => text.toLocaleLowerCase().indexOf(t)).filter(i => i >= 0)) - 35);
      snippet = (pos ? "…" : "") + text.slice(pos, pos + 180);
    }
    return { session, snippet, document: document < 0 ? undefined : document };
  }).filter((m): m is Match => !!m).sort((a, b) => b.session.modified - a.session.modified);
}
