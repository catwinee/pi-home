/** Real Pi + tmux smoke test. Synthetic sessions only; isolated HOME/agent dir; no network/models. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "pi-home-pty-")), socket = `pi-home-${process.pid}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function tmux(...args: string[]): string {
  const r = spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
  if (r.error) throw r.error;
  if (r.status) throw new Error(r.stderr || `tmux ${args[0]} failed`);
  return r.stdout;
}
const capture = () => tmux("capture-pane", "-p", "-t", "smoke");
async function wait(text: string): Promise<string> {
  for (let i = 0; i < 100; i++) { const s = capture(); if (s.includes(text)) return s; await sleep(100); }
  throw new Error(`Timed out waiting for ${JSON.stringify(text)}:\n${capture()}`);
}
async function command(text: string): Promise<void> { tmux("send-keys", "-t", "smoke", "-l", text); tmux("send-keys", "-t", "smoke", "Enter"); await sleep(100); }
const key = (...keys: string[]) => tmux("send-keys", "-t", "smoke", ...keys);
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
let success = false;
try {
  for (const dir of ["home", "work", "agent/sessions/project"]) await mkdir(join(root, dir), { recursive: true });
  const now = Date.now(), timestamp = new Date(now).toISOString();
  for (let i = 0; i < 3; i++) {
    const entries = [
      { type: "session", version: 3, id: `fixture-${i}`, timestamp, cwd: join(root, "work") },
      { type: "message", id: `user${i}`, parentId: null, timestamp, message: { role: "user", content: `Synthetic ${i}: 中文缓存问题`, timestamp: now } },
      { type: "message", id: `asst${i}`, parentId: `user${i}`, timestamp, message: { role: "assistant", content: [{ type: "text", text: "No model request made.\n" + Array.from({ length: 50 }, (_, n) => `Preview line ${n}`).join("\n") }], api: "openai-responses", provider: "openai", model: "gpt-4.1", usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 0, totalTokens: 350, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: now + 1 } },
    ];
    await writeFile(join(root, `agent/sessions/project/${i}.jsonl`), entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  }
  await writeFile(join(root, "agent/sessions/project/other.jsonl"), JSON.stringify({ type: "session", version: 3, id: "other-work", timestamp: new Date(now - 86400000).toISOString(), cwd: join(root, "other-work") }) + "\n");
  await mkdir(join(root, "work/.pi/subagents/artifacts"), { recursive: true });
  await writeFile(join(root, "work/.pi/subagents/artifacts/report.md"), "Synthetic report: retain me.\n");
  await mkdir(join(root, "agent/sessions/project/subagent-artifacts"));
  await writeFile(join(root, "agent/sessions/project/subagent-artifacts/worker_transcript.jsonl"), '{"role":"user","content":"artifact"}\n');
  await writeFile(join(root, "agent/sessions/project/2026-07-12T00-00-00_broken.jsonl"), '{}\n');
  await writeFile(join(root, "work/AGENTS.md"), "Synthetic smoke-test context only.\n");
  await mkdir(join(root, "agent/skills/example"), { recursive: true });
  await mkdir(join(root, "agent/skills/duplicate"), { recursive: true });
  const skill = "---\nname: example\ndescription: Synthetic test only\n---\nNo actions.\n";
  await writeFile(join(root, "agent/skills/example/SKILL.md"), skill);
  await writeFile(join(root, "agent/skills/duplicate/SKILL.md"), skill);
  await mkdir(join(root, "agent/prompts"), { recursive: true });
  await writeFile(join(root, "agent/prompts/review.md"), "Synthetic prompt.\n");
  // Test-only preload invokes the actual native notification methods after explicit file signals.
  // The process stays --offline; no version/package network checks or real settings are used.
  const updatesPreload = join(root, "synthetic-updates.mjs");
  await writeFile(updatesPreload, `
import { access } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { InteractiveMode } from ${JSON.stringify(join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js"))};
const root = ${JSON.stringify(root)};
async function signal(name) { for (;;) { try { await access(root + "/" + name); return; } catch { await sleep(25); } } }
const original = InteractiveMode.prototype.init;
InteractiveMode.prototype.init = async function (...args) {
  const result = await original.apply(this, args);
  void (async () => {
    await signal("emit-core");
    this.showNewVersionNotification({ version: "1.3.0", note: "Synthetic native release note: hidden in compact mode." });
    await signal("emit-packages");
    this.showPackageUpdateNotification(["npm:synthetic-update", "git:synthetic-update"]);
    await signal("emit-warning");
    this.showWarning("Synthetic unrelated warning remains visible");
  })();
  return result;
};
`);
  const launch = (mode: "fullscreen" | "regular", columns = 110, rows = 56, updates = false) => {
    const env = [`HOME=${join(root, "home")}`, `PATH=${process.env.PATH}`, "TERM=xterm-256color", "LANG=C.UTF-8", `PI_CODING_AGENT_DIR=${join(root, "agent")}`, `PI_SUBAGENTS_TEMP_ROOT=${join(root, "private-temp")}`];
    const args = [process.execPath, ...(updates ? ["--import", updatesPreload] : []), join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), "--offline", "--no-extensions", "--no-themes", "--no-approve", "--tui-mode", mode, "-e", join(repo, "src/index.ts")];
    tmux("new-session", "-d", "-s", "smoke", "-x", String(columns), "-y", String(rows), "-c", join(root, "work"), `env -i ${[...env, ...args].map(quote).join(" ")}`);
  };
  launch("fullscreen");
  await wait("messages 3"); // [Activity] is already present in the pending skeleton.
  assert.ok(capture().includes("Context 1 · Skills 1 · Extensions 1"));
  assert.ok(capture().includes("[Skill conflicts]"), "native resource warnings remain visible even while inventory is folded");
  assert.ok(capture().includes("Press ctrl+o to show full startup help and loaded resources."));
  assert.ok(!capture().includes("[Extensions]"));
  assert.ok(!capture().includes("Pi can explain"));
  key("C-o"); await wait("[Extensions]");
  key("C-o"); await sleep(200); assert.ok(!capture().includes("[Extensions]"));
  await command("/home resources"); await wait("Loaded resources · native Pi inventory");
  assert.ok(capture().includes("[Extensions]"));
  assert.ok(capture().includes("[Prompts]")); key("Escape"); await sleep(100);
  await command("/reload"); await wait("Reloaded keybindings"); await wait("messages 3");
  assert.ok(capture().includes("Context 1 · Skills 1 · Extensions 1"));
  assert.ok(!capture().includes("[Extensions]"));
  assert.ok(!capture().includes("[Workspace]"));
  await command("/workspaces"); await wait("/other-work");
  key("/"); tmux("send-keys", "-t", "smoke", "-l", "other-work"); key("Enter", "Enter");
  await wait("[Sessions]"); await wait("1/1");
  assert.ok(capture().includes("/other-work"));
  key("w"); await wait("[Workspaces]"); key("Escape"); await wait("[Sessions]");
  assert.ok(capture().includes("/other-work")); key("Escape"); await sleep(100);
  const cacheBeforeInventory = await readFile(join(root, "agent/pi-home/cache.json"), "utf8");
  await command("/artifacts"); await wait("diagnostics · i:scope");
  assert.ok(capture().includes("[Artifacts · read-only]"));
  key("d"); await access(join(root, "work/.pi/subagents/artifacts/report.md"));
  key("Enter"); await wait("Direct entries"); key("Escape"); await wait("Enter:details w:cwd");
  key("a"); await wait("All locations"); key("i"); await wait("[Scope / diagnostics]");
  key("Escape"); await wait("Enter:details w:cwd"); key("Escape"); await sleep(100);
  assert.equal(await readFile(join(root, "agent/pi-home/cache.json"), "utf8"), cacheBeforeInventory, "artifacts inventory does not refresh/rewrite the conversation cache");
  assert.equal(await readFile(join(root, "work/.pi/subagents/artifacts/report.md"), "utf8"), "Synthetic report: retain me.\n");
  await command("/home"); await wait("Search:");
  key("i"); await wait("Expected a Pi session");
  assert.ok(!capture().includes("worker_transcript"), "artifact directories are not diagnosed as corrupt sessions");
  key("h"); await wait("Search:");
  key("Enter"); await wait("Read-only");
  key("d"); await wait("Move to recoverable trash?"); key("Enter"); // Cancel is default.
  await wait("Read-only"); await access(join(root, "agent/sessions/project/0.jsonl"));
  key("d"); await wait("Move to recoverable trash?"); key("Down", "Enter"); await wait("Moved to trash");
  await assert.rejects(access(join(root, "agent/sessions/project/0.jsonl")));
  key("p"); await wait("3 user"); // Project accounting still includes the trashed session.
  key("u"); await wait("Restored"); await access(join(root, "agent/sessions/project/0.jsonl"));
  key("s"); key("R"); await wait("Resumed session");
  await command("/delete"); await wait("Move to recoverable trash?"); key("Down", "Enter"); await wait("Session moved to trash");
  await assert.rejects(access(join(root, "agent/sessions/project/0.jsonl")));
  await command("/home undo"); await wait("Restored");
  await command("/home sessions"); await wait("Search:");
  tmux("resize-window", "-t", "smoke", "-x", "60", "-y", "24");
  key("/"); tmux("send-keys", "-t", "smoke", "-l", "中文缓存"); key("Enter"); await wait("中文缓存");
  key("Enter"); await wait("Read-only"); key("Escape"); await sleep(100); key("Escape"); await sleep(100);
  assert.ok(!capture().includes("Expected a Pi session"), "diagnostics do not leak into the transcript after quit");
  await command("/home startup off"); await wait("Home startup off");
  assert.equal(JSON.parse(await readFile(join(root, "agent/pi-home/config.json"), "utf8")).startup, false);
  tmux("kill-session", "-t", "smoke");
  launch("regular"); await wait("No models available");
  assert.ok(!capture().includes("[Activity]"), "startup off restores native presentation");
  await command("/home startup on"); await wait("Home startup on");
  tmux("kill-session", "-t", "smoke");
  launch("regular"); await wait("messages 3");
  assert.ok(capture().includes("Context 1 · Skills 1 · Extensions 1"));
  key("C-o"); await wait("[Extensions]"); key("C-o"); await sleep(100);
  assert.ok(!capture().includes("[Extensions]"));
  await command("/home sessions"); await wait("Search:"); key("Enter"); await wait("Read-only");
  tmux("kill-session", "-t", "smoke");
  await rm(join(root, "agent/skills/duplicate"), { recursive: true });
  await rm(join(root, "agent/sessions/project/2026-07-12T00-00-00_broken.jsonl"));
  // A dummy local model avoids the long no-model onboarding warning in layout acceptance tests.
  // No requests are made; no real credentials are read or used.
  await writeFile(join(root, "agent/models.json"), JSON.stringify({ providers: { smoke: {
    baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "synthetic-unused",
    models: [{ id: "smoke", contextWindow: 8192, maxTokens: 1024 }],
  } } }));
  launch("fullscreen", 80, 40); await wait("messages 3");
  const full = capture();
  for (const label of ["v1.2.0", "Context 1", "[Today]", "[Activity]", "CH R", "Sun", "Sat"]) assert.ok(full.includes(label), `${label} absent at 80x40:\n${full}`);
  assert.ok(full.indexOf("[Today]") < full.indexOf("[Activity]"));
  assert.ok(!full.includes("│"), "startup is single-column");
  for (const columns of [80, 60]) {
    tmux("resize-window", "-t", "smoke", "-x", String(columns), "-y", "24"); await sleep(300);
    for (const label of ["[Activity]", "Sun", "Sat"]) assert.ok(capture().includes(label), `${label} absent at ${columns}x24:\n${capture()}`);
  }
  tmux("kill-session", "-t", "smoke");
  for (const mode of ["fullscreen", "regular"] as const) {
    for (const name of ["emit-core", "emit-packages", "emit-warning"]) await rm(join(root, name), { force: true });
    launch(mode, 110, 56, true); await wait("messages 3");
    const pending = capture();
    assert.ok(!pending.includes("update available:") && !pending.includes("Extensions 1↑"));
    tmux("send-keys", "-t", "smoke", "-l", "更新检测期间输入"); await wait("更新检测期间输入");
    await writeFile(join(root, "emit-core"), "go"); await wait("v1.2.0 update available: v1.3.0");
    await writeFile(join(root, "emit-packages"), "go"); await wait("Extensions 1↑");
    const ready = capture();
    assert.ok(ready.includes("更新检测期间输入"), "late notifications preserve the editor draft");
    assert.equal(ready.split("\n").findIndex(l => l.includes("[Activity]")), pending.split("\n").findIndex(l => l.includes("[Activity]")), "updates do not shift the wide-screen overview");
    assert.ok(!/Update Available|Package Updates Available|Synthetic native release note|npm:synthetic-update/.test(ready));
    await writeFile(join(root, "emit-warning"), "go"); await wait("Synthetic unrelated warning remains visible");
    key("C-o"); await wait("[Extensions]");
    assert.ok(!capture().includes("Package Updates Available")); key("C-o"); key("C-u");
    await command("/reload"); await wait("Reloaded keybindings"); await wait("Extensions 1↑");
    assert.ok(capture().includes("update available: v1.3.0"), "native update state survives extension reload");
    await command("/new"); await wait("Extensions 1↑");
    assert.ok(capture().includes("update available: v1.3.0"), "native update state survives a new session");
    tmux("kill-session", "-t", "smoke");
  }
  success = true;
  console.log("PASS: real Pi fullscreen + regular; native startup logo/counts without redundant Workspace, delayed native updates inline without boxes/draft loss/overview shifts, update persistence across reload/new, Ctrl+O, resources, cwd picker/filter, read-only artifact inventory, warning preservation, reload, 80x24/60x24 heatmap, scoped discovery, quiet diagnostics, preview, safe cancellation, trash, undo, resume, /delete, Chinese search, startup setting.");
} catch (error) {
  console.error(`Smoke fixtures retained at ${root}`); throw error;
} finally {
  try { tmux("kill-server"); } catch { /* already exited */ }
  // Preserve only if the test failed, for diagnosis.
  if (success) await rm(root, { recursive: true, force: true });
}
