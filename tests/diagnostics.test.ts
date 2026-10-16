import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import extension from "../src/index.js";
import { HomePanel, initialState, type Action } from "../src/home.js";
import { parseSessionText } from "../src/stats.js";
import { fixture, sample, header, msg, jsonl } from "./fixtures.js";
const theme = { fg: (_: unknown, s: string) => s, bg: (_: unknown, s: string) => s, bold: (s: string) => s };

test("scan warnings stay in diagnostics; repeated refresh and quit never queue notifications", async () => {
  const f = await fixture(), old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.dir;
  try {
    const artifact = join(f.root, "--project--", "subagent-artifacts"); await mkdir(artifact, { recursive: true });
    await writeFile(join(artifact, "worker_transcript.jsonl"), jsonl({ role: "user", content: "not a session" }));
    await writeFile(join(f.root, "2026-07-12T00-00-00_broken.jsonl"), "{}\n");
    const commands: Record<string, any> = {}, notices: string[] = [], screens: string[] = []; let count = 0;
    extension({ registerCommand: (name: string, spec: any) => { commands[name] = spec; }, on() {} } as any);
    await commands.home.handler("diagnostics", { mode: "tui", cwd: "/work/项目", isIdle: () => true,
      sessionManager: { getSessionFile: () => undefined, getSessionDir: () => f.root },
      ui: { setWidget() {}, notify(s: string) { notices.push(s); }, custom: async (factory: any) => {
        const component = await factory({ terminal: { rows: 50 }, requestRender() {} }, theme, {}, () => {});
        screens.push(component.render(200).join("\n")); return { kind: count++ === 0 ? "refresh" : "close" };
      } },
    });
    assert.deepEqual(notices, []); assert.equal(screens.length, 2);
    for (const screen of screens) {
      assert.match(screen, /Expected a Pi session/);
      assert.equal((screen.match(/Expected a Pi session/g) || []).length, 1);
      assert.ok(!screen.includes("worker_transcript"));
    }
  } finally { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; await f.close(); }
});

test("a bad activity registry does not prevent browsing while deletion remains blocked", async () => {
  const f = await fixture(), old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.dir;
  try {
    await mkdir(f.p.leases, { recursive: true }); await writeFile(join(f.p.leases, "bad.json"), "{");
    const commands: Record<string, any> = {}, notices: string[] = []; let shown = false;
    extension({ registerCommand: (name: string, spec: any) => { commands[name] = spec; }, on() {} } as any);
    await commands.home.handler("diagnostics", { mode: "tui", cwd: "/work/项目", isIdle: () => true,
      sessionManager: { getSessionFile: () => undefined, getSessionDir: () => f.root },
      ui: { setWidget() {}, notify(s: string) { notices.push(s); }, custom: async (factory: any) => {
        const panel = await factory({ terminal: { rows: 50 }, requestRender() {} }, theme, {}, () => {});
        assert.match(panel.render(200).join("\n"), /deletion remains blocked/); shown = true; return { kind: "close" };
      } },
    });
    assert.ok(shown); assert.deepEqual(notices, []);
  } finally { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; await f.close(); }
});

test("search preview jumps only once: resize/invalidate does not pull g back to the match", () => {
  const s = parseSessionText(jsonl(header(), msg("a", "user", "before\n".repeat(80)), msg("b", "user", "needle")), "/s.jsonl");
  const state = initialState(); state.view = "sessions"; state.query = "needle";
  const panel = new HomePanel({ sessions: [s], trash: [], active: new Set(), state, status: "", cwd: s.cwd, theme, height: () => 20, done() {} });
  panel.handleInput("\r"); panel.render(80); assert.ok(state.previewScroll > 0);
  panel.handleInput("g"); panel.invalidate(); panel.render(60); assert.equal(state.previewScroll, 0);
});

test("two trash versions sharing an original path preview and restore the selected version", () => {
  const first = parseSessionText(sample("first"), "/same.jsonl"), second = parseSessionText(sample("second"), "/same.jsonl");
  first.trashed = "A"; second.trashed = "B"; second.name = "second version";
  const state = initialState(); state.view = "trash"; const actions: Action[] = [];
  const panel = new HomePanel({ sessions: [], trash: [first, second], active: new Set(), state, status: "", cwd: "", theme, height: () => 30, done(a) { actions.push(a); } });
  panel.handleInput("j"); panel.handleInput("\r");
  assert.match(panel.render(80).join("\n"), /second version/);
  panel.handleInput("d"); assert.equal(actions[0]?.id, "B");
});
