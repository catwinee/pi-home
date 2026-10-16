/** Synthetic scale check. No user session data or model calls. Not a timing assertion in CI. */
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate, parseRange, refreshCache, searchSessions } from "../src/stats.js";
import { HomePanel, initialState } from "../src/home.js";
import { header, msg, assistant, jsonl, now } from "./fixtures.js";
const root = await mkdtemp(join(tmpdir(), "pi-home-bench-"));
const count = Number(process.argv[2] || 1000);
if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error("Use 1..10000 synthetic sessions");
const theme = { fg: (_: unknown, s: string) => s, bg: (_: unknown, s: string) => s, bold: (s: string) => s };
const timed = <T>(fn: () => T) => { const start = performance.now(); const value = fn(); return { value, ms: performance.now() - start }; };
try {
  const sessions = join(root, "sessions"), cache = join(root, "cache.json"); await mkdir(sessions);
  for (let i = 0; i < count; i++) {
    const entries: unknown[] = [header(`s${i}`, `/cwd/${i % 20}`, now - i * 1000)];
    for (let j = 0; j < 12; j++) {
      entries.push(msg(`u${j}`, "user", `Question ${i}/${j}: 中文缓存测试 ${"test text ".repeat(30)}`, now + j));
      entries.push(assistant(`a${j}`, now + j));
    }
    await writeFile(join(sessions, `${i}.jsonl`), jsonl(...entries));
  }
  const first = await refreshCache([sessions], cache), warm = await refreshCache([sessions], cache);
  const empty = timed(() => searchSessions(warm.sessions, ""));
  const search = timed(() => searchSessions(warm.sessions, "中文缓存"));
  const repeats = timed(() => { for (let i = 0; i < 20; i++) searchSessions(warm.sessions, "中文缓存 test"); });
  const stats = timed(() => aggregate(warm.sessions, parseRange("all")));
  const panel = timed(() => new HomePanel({ sessions: warm.sessions, trash: [], active: new Set(), state: initialState(), status: "benchmark", cwd: "/cwd/0", theme, height: () => 40, done() {} }).render(100));
  console.log(JSON.stringify({ sessions: count, entriesPerSession: 25, firstScanMs: Math.round(first.durationMs),
    warmScanMs: Math.round(warm.durationMs), reused: warm.reused, emptySearchMs: +empty.ms.toFixed(1),
    firstTextSearchMs: +search.ms.toFixed(1), repeatedSearchMeanMs: +(repeats.ms / 20).toFixed(1),
    aggregateMs: +stats.ms.toFixed(1), panelConstructAndRenderMs: +panel.ms.toFixed(1),
    cacheMiB: +((await stat(cache)).size / 1048576).toFixed(1), rssMiB: +(process.memoryUsage().rss / 1048576).toFixed(1),
    expectedUsers: count * 12, actualUsers: stats.value.totals.users }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
