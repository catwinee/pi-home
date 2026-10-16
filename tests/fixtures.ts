import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../src/store.js";
export const now = new Date(2026, 6, 12, 12).getTime();
export const iso = (n = now) => new Date(n).toISOString();
export const usage = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100, cost: { total: .01 } };
export const header = (id = "one", cwd = "/work/项目", time = now, parentSession?: string) => ({ type: "session", version: 3, id, cwd, timestamp: iso(time), parentSession });
export const msg = (id: string, role: string, content: unknown, time = now, extra = {}) => ({ type: "message", id, parentId: null, timestamp: iso(time), message: { role, content, timestamp: time, ...extra } });
export const assistant = (id = "a", time = now) => msg(id, "assistant", [{ type: "text", text: "回答缓存问题" }, { type: "thinking", thinking: "private reasoning" }, { type: "toolCall", id: "tc", name: "bash", arguments: { command: "pwd" } }], time, { usage, provider: "p", model: "m" });
export const jsonl = (...entries: unknown[]) => entries.map(e => JSON.stringify(e)).join("\n") + "\n";
export const sample = (id = "one", time = now) => jsonl(header(id, "/work/项目", time), msg("u", "user", "请排查中文缓存问题", time), assistant("a", time + 1));
export async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-home-test-")), p = paths(dir), root = join(dir, "sessions");
  await mkdir(root);
  const file = join(root, "one.jsonl"); await writeFile(file, sample());
  return { dir, p, root, file, close: () => rm(dir, { recursive: true, force: true }) };
}
