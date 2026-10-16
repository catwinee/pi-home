import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, readFile, writeFile, mkdir } from "node:fs/promises";
import extension, { deleteCurrent, shouldShowStartup } from "../src/index.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { setImmediate as nextTurn } from "node:timers/promises";
import { refreshCache } from "../src/stats.js";
import type { StartupHeader } from "../src/startup.js";
import { TrashStore } from "../src/store.js";
import { fixture } from "./fixtures.js";

test("startup dashboard for fresh launches or empty reloads, not resume/new/conversations/explicit flags", () => {
  assert.ok(shouldShowStartup("startup", false, ["pi"]));
  assert.equal(shouldShowStartup("resume", false, []), false);
  assert.equal(shouldShowStartup("reload", false, []), true);
  assert.equal(shouldShowStartup("reload", true, []), false);
  assert.equal(shouldShowStartup("new", false, []), false);
  assert.equal(shouldShowStartup("startup", true, []), false);
  for (const arg of ["-c", "--resume", "--session=x", "--no-session"]) assert.equal(shouldShowStartup("startup", false, [arg]), false);
});
test("factory registers commands/hooks only and no model-callable destructive tool", () => {
  const commands: string[] = [], hooks: string[] = [];
  extension({ registerCommand: (name: string) => commands.push(name), on: (name: string) => hooks.push(name) } as any);
  assert.deepEqual(commands, ["home", "workspaces", "artifacts", "delete"]); assert.ok(hooks.includes("session_shutdown"));
});
test("delete-current cancellation leaves original untouched", async () => {
  const f = await fixture();
  try {
    let switched = false;
    const ctx = { isIdle: () => true, sessionManager: { getSessionFile: () => f.file }, ui: { select: async () => "Cancel" }, newSession: async () => { switched = true; } } as unknown as ExtensionCommandContext;
    const store = new TrashStore(f.p, [f.root]); await deleteCurrent(ctx, store);
    assert.equal(switched, false); assert.equal((await store.list()).length, 0); await store.prepare(f.file);
  } finally { await f.close(); }
});
test("cancelled session replacement never deletes", async () => {
  const f = await fixture();
  try {
    const ctx = { isIdle: () => true, sessionManager: { getSessionFile: () => f.file }, ui: { select: async () => "Move to trash", notify() {} }, newSession: async () => ({ cancelled: true }) } as unknown as ExtensionCommandContext;
    const store = new TrashStore(f.p, [f.root]); await deleteCurrent(ctx, store);
    assert.equal((await store.list()).length, 0); await store.prepare(f.file);
  } finally { await f.close(); }
});
test("delete switches first, mutates only in fresh context and does not use old UI", async () => {
  const f = await fixture();
  try {
    let switched = false, freshNotified = false;
    const store = new TrashStore(f.p, [f.root]);
    const ctx = { isIdle: () => { assert.equal(switched, false); return true; }, sessionManager: { getSessionFile: () => { assert.equal(switched, false); return f.file; } },
      ui: { select: async () => "Move to trash", notify() { throw new Error("old UI used"); } },
      newSession: async ({ withSession }: any) => {
        switched = true;
        await withSession({ isIdle: () => true, sessionManager: { getSessionFile: () => undefined }, ui: { notify: () => { freshNotified = true; } } });
        return { cancelled: false };
      },
    } as unknown as ExtensionCommandContext;
    await deleteCurrent(ctx, store); assert.ok(freshNotified); assert.equal((await store.list()).length, 1);
  } finally { await f.close(); }
});
test("dashboard rejects a file modified since its cached preview before asking to delete", async () => {
  const f = await fixture(), old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.dir;
  try {
    const commands: Record<string, any> = {}, notices: string[] = [], screens: string[] = []; let calls = 0, confirmations = 0;
    extension({ registerCommand: (name: string, spec: any) => { commands[name] = spec; }, on() {} } as any);
    const ctx = { mode: "tui", cwd: "/work/项目", isIdle: () => true,
      sessionManager: { getSessionFile: () => undefined, getSessionDir: () => f.root },
      ui: { setWidget() {}, notify(s: string) { notices.push(s); }, select: async () => { confirmations++; return "Move to trash"; },
        custom: async (factory: any) => {
          const component = await factory({ terminal: { rows: 50 }, requestRender() {} }, { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s }, {}, () => {});
          if (calls++ === 0) { await appendFile(f.file, "\n"); return { kind: "delete", path: f.file }; }
          component.handleInput("i"); screens.push(component.render(180).join("\n"));
          return { kind: "close" };
        },
      },
    };
    await commands.home.handler("sessions", ctx);
    assert.equal(confirmations, 0); assert.ok(screens.some(s => s.includes("changed since the displayed preview")));
    assert.deepEqual(notices, [], "No queued notifications after leaving Home");
    assert.equal((await new TrashStore(f.p, [f.root]).list()).length, 0);
  } finally { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; await f.close(); }
});
test("artifacts/workspaces commands read metadata without rewriting cache, deleting files or queuing notifications", async () => {
  const f = await fixture(), old = process.env.PI_CODING_AGENT_DIR, oldTemp = process.env.PI_SUBAGENTS_TEMP_ROOT;
  process.env.PI_CODING_AGENT_DIR = f.dir; process.env.PI_SUBAGENTS_TEMP_ROOT = `${f.dir}/isolated-temp`;
  try {
    await mkdir(f.p.home, { recursive: true }); await writeFile(f.p.cache, "CACHE MUST NOT BE PARSED OR REWRITTEN");
    const commands: Record<string, any> = {}, notices: string[] = [];
    extension({ registerCommand: (name: string, spec: any) => { commands[name] = spec; }, on() {} } as any);
    const ctx = { mode: "tui", cwd: `${f.dir}/cwd`, isIdle: () => true,
      sessionManager: { getSessionDir: () => f.root, getSessionFile: () => undefined },
      ui: { notify(message: string) { notices.push(message); }, custom: async (factory: any) => {
        const c = factory({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_: unknown, s: string) => s, bg: (_: unknown, s: string) => s, bold: (s: string) => s }, {}, () => {});
        try {
          for (let i = 0; i < 100 && c.render(120).join("\n").includes("Scanning bounded"); i++) await new Promise(r => setTimeout(r, 10));
          assert.ok(!c.render(120).join("\n").includes("Scanning bounded"));
          return { kind: "close" };
        } finally { c.dispose(); }
      } },
    };
    assert.equal(commands.cleanup, undefined, "No misleading cleanup alias");
    await commands.artifacts.handler("all", ctx); await commands.workspaces.handler("", ctx);
    assert.equal(await readFile(f.p.cache, "utf8"), "CACHE MUST NOT BE PARSED OR REWRITTEN");
    assert.deepEqual(notices, []); await new TrashStore(f.p, [f.root]).prepare(f.file);
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    if (oldTemp === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT; else process.env.PI_SUBAGENTS_TEMP_ROOT = oldTemp;
    await f.close();
  }
});
test("pending startup is immediate; new/reload/shutdown never publish stale background results", async () => {
  class NativeHeader extends Text {
    onLogoClick = undefined;
    state = { expanded: false };
    build() { return "Pi v1.2.0\nshortcuts\nPress ctrl+o to show full startup help and loaded resources."; }
    setExpanded(expanded: boolean) { this.state.expanded = expanded; }
  }
  for (const action of ["new", "reload", "shutdown"]) {
    const f = await fixture(), old = process.env.PI_CODING_AGENT_DIR, oldSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_DIR = f.dir; process.env.PI_CODING_AGENT_SESSION_DIR = f.root;
    const hooks: Record<string, any> = {};
    try {
      const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s };
      const root = new Container(), document = new Container(), headerBox = new Container();
      headerBox.addChild(new NativeHeader("", 0, 0));
      document.addChild(headerBox); document.addChild(new Container()); document.addChild(new Container()); root.addChild(document);
      Object.assign(root, { requestRender() {} });
      const view: { current?: StartupHeader } = {}, notices: string[] = [];
      extension({ registerCommand() {}, getSettings: () => ({ quietStartup: false }), on: (name: string, handler: any) => { hooks[name] = handler; } } as any);
      const ctx = { mode: "tui", cwd: "/work/synthetic", sessionManager: { getSessionFile: () => undefined, getSessionDir: () => f.root, getEntries: () => [] },
        ui: { notify: (text: string) => notices.push(text), setWidget: (_name: string, factory: any) => { factory?.(root, theme); },
          setHeader: (factory: any) => { view.current?.dispose(); view.current = factory?.(); } } };
      await hooks.session_start({ reason: "startup" }, ctx);
      const first = view.current!;
      assert.equal(first.loading, true); assert.equal(first.data, undefined);
      assert.match(first.render(110).join("\n"), /messages —/);
      const scan = refreshCache([f.root], f.p.cache, new TrashStore(f.p, [f.root]).discovery);
      if (action === "shutdown") await hooks.session_shutdown();
      else await hooks.session_start({ reason: action }, ctx);
      await scan; await nextTurn();
      assert.equal(first.data, undefined); assert.equal(first.disposed, true);
      if (action === "new") {
        assert.doesNotMatch(view.current!.render(110).join("\n"), /\[Today\]|\[Activity\]|messages —/);
      } else if (action === "reload") {
        const deadline = performance.now() + 2000;
        while (!view.current?.data && performance.now() < deadline) await new Promise(r => setTimeout(r, 1));
        assert.ok(view.current?.data); assert.equal(view.current.loading, false);
        assert.match(view.current.render(110).join("\n"), /\[Activity\]/);
      }
      assert.deepEqual(notices, []);
    } finally {
      await hooks.session_shutdown?.();
      if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
      if (oldSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR; else process.env.PI_CODING_AGENT_SESSION_DIR = oldSessions;
      await f.close();
    }
  }
});
test("busy sessions refuse deletion before confirmation", async () => {
  const f = await fixture();
  try { await assert.rejects(deleteCurrent({ isIdle: () => false } as any, new TrashStore(f.p, [f.root])), /finish/); }
  finally { await f.close(); }
});
