import { VERSION, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HomePanel, initialState, type Action, type HomeState } from "./home.js";
import { attachNativeStartup, unavailableResources } from "./native-startup.js";
import { ResourcesPanel, StartupHeader } from "./startup.js";
import { scanInventory, subagentTempRoot } from "./inventory.js";
import { InventoryPanel, inventoryState, type InventoryAction } from "./workspaces.js";
import { aggregateCooperatively, atomicJson, mergeSessions, parseRange, refreshCache, safeText, type Session } from "./stats.js";
import type { Diagnostic } from "./discovery.js";
import { ActiveLease, activePaths, loadConfig, paths, sessionRoots, TrashStore, type Paths, type Ticket } from "./store.js";

function requireIdle(ctx: ExtensionContext): void {
  if (!ctx.isIdle()) throw new Error("Wait for Pi to finish before managing sessions.");
}
async function confirmTrash(ctx: ExtensionCommandContext, ticket: Ticket): Promise<boolean> {
  const message = `Move to recoverable trash?\n${safeText(ticket.session.name)}\n${safeText(ticket.path)}${ticket.session.warnings ? `\nWarning: ${ticket.session.warnings} malformed/undated entries; preview may be incomplete.` : ""}\nOther Pi instances without pi-home cannot be detected. Ensure they are closed.`;
  return await ctx.ui.select(message, ["Cancel", "Move to trash"]) === "Move to trash";
}
export async function deleteCurrent(ctx: ExtensionCommandContext, store: TrashStore): Promise<void> {
  requireIdle(ctx);
  const path = ctx.sessionManager.getSessionFile();
  if (!path) throw new Error("This session has no saved file.");
  const ticket = await store.prepare(path);
  if (!await confirmTrash(ctx, ticket)) return;
  requireIdle(ctx);
  const result = await ctx.newSession({
    withSession: async fresh => {
      // Old ctx and its extension runtime are invalid after replacement.
      try {
        requireIdle(fresh);
        await store.move(ticket, fresh.sessionManager.getSessionFile());
        fresh.ui.notify("Session moved to trash. /home to browse; /home undo to restore.", "info");
      } catch (err: any) {
        fresh.ui.notify(`Deletion did not complete: ${err.message}. Check the original path and any reported recovery copy before retrying.`, "error");
      }
    },
  });
  if (result.cancelled) ctx.ui.notify("Session switch cancelled; nothing was deleted.", "info");
}

export function shouldShowStartup(reason: string, hasConversation: boolean, argv: string[]): boolean {
  return (reason === "startup" || reason === "reload") && !hasConversation && !argv.some(a => ["--continue", "-c", "--resume", "-r", "--session", "--fork", "--no-session"].includes(a) || a.startsWith("--session=") || a.startsWith("--resume="));
}

export default function (pi: ExtensionAPI): void {
  const p = paths();
  let lease: ActiveLease | undefined;
  let generation = 0;
  let startup: StartupHeader | undefined;
  let startupAbort: AbortController | undefined;
  const listingEnabled = () => !pi.getSettings().quietStartup;
  pi.on("session_start", async (event, ctx) => {
    generation++;
    startupAbort?.abort(); startupAbort = undefined;
    if (ctx.mode === "tui" && startup && !startup.disposed) ctx.ui.setHeader(undefined);
    startup = undefined;
    await lease?.close();
    lease = new ActiveLease(p);
    try { await lease.set(ctx.sessionManager.getSessionFile()); }
    catch { if (ctx.mode === "tui") ctx.ui.notify("pi-home: active-session protection unavailable; cleanup will need caution.", "warning"); }
    if (ctx.mode !== "tui") return;
    const config = await loadConfig(p);
    if (!config.startup) return;
    const ownGeneration = generation;
    let requestRender = () => {};
    // A zero-height, immediately removed probe gives us the public TUI reference BEFORE replacing
    // anything. Only a positively identified native layout is adapted; other custom headers survive.
    ctx.ui.setWidget("pi-home-probe", (tui, theme) => {
      const bridge = attachNativeStartup(tui, VERSION, listingEnabled());
      if (bridge) {
        startup = new StartupHeader(bridge, theme);
        const header = startup;
        ctx.ui.setHeader(() => header);
        requestRender = () => tui.requestRender();
      }
      return { render: () => [], invalidate() {} };
    });
    ctx.ui.setWidget("pi-home-probe", undefined);
    const header = startup as StartupHeader | undefined; // setWidget's factory is invoked synchronously by Pi.
    if (!header || !shouldShowStartup(event.reason, ctx.sessionManager.getEntries().some(e => e.type === "message" && e.message.role === "user"), process.argv)) return;
    header.loading = true;
    const controller = startupAbort = new AbortController();
    requestRender();
    // Static startup snapshot, in the header rather than an editor widget. Never steals prompt focus.
    void (async () => {
      const roots = sessionRoots(p, config, ctx.sessionManager.getSessionDir());
      const store = new TrashStore(p, roots, config.recursiveSessionRoots);
      const scan = await refreshCache(roots, p.cache, store.discovery);
      if (generation !== ownGeneration || header.disposed) return;
      const trash = await store.inspect();
      if (generation !== ownGeneration || header.disposed) return;
      const warnings = [...scan.diagnostics, ...trash.diagnostics].filter(d => d.level === "warning").length;
      const all = mergeSessions(scan.sessions, trash.records.map(r => r.session));
      if (generation !== ownGeneration || header.disposed) return;
      const now = Date.now();
      const [today, history] = await aggregateCooperatively(all, [parseRange("today", now), parseRange("all", now)], undefined, controller.signal);
      if (generation !== ownGeneration || header.disposed) return;
      header.data = { today: today!, history: history!, warnings };
      header.loading = false; requestRender();
    })().catch((err: any) => {
      if (generation === ownGeneration && !header.disposed) {
        header.loading = false; header.error = safeText(err.message); requestRender();
      }
    });
  });
  pi.on("session_shutdown", async () => { generation++; startupAbort?.abort(); startup?.dispose(); await lease?.close(); });

  const home = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (ctx.mode !== "tui") { ctx.ui.notify("pi-home requires interactive TUI mode.", "error"); return; }
    try {
      requireIdle(ctx);
      if (args.trim() === "resources") {
        await ctx.ui.custom<void>((tui, theme, _kb, done) => {
          const temporary = !startup || startup.disposed ? attachNativeStartup(tui, VERSION, listingEnabled()) : undefined;
          const bridge = startup && !startup.disposed ? startup.bridge : temporary;
          const panel = new ResourcesPanel(() => bridge?.snapshot() ?? unavailableResources("Native inventory unavailable: this layout/version is unsupported, or another extension owns the header."), theme, () => Math.max(5, Math.floor(tui.terminal.rows * .9)), () => done());
          return { render: (width: number) => panel.render(width), invalidate: () => panel.invalidate(),
            handleInput(data: string) { panel.handleInput(data); tui.requestRender(); }, dispose() { temporary?.dispose(); } };
        }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "95%", anchor: "center" } });
        return;
      }
      const config = await loadConfig(p);
      const roots = sessionRoots(p, config, ctx.sessionManager.getSessionDir());
      const store = new TrashStore(p, roots, config.recursiveSessionRoots);
      const arg = args.trim();
      if (arg.startsWith("startup ")) {
        const value = arg.slice(8).trim();
        if (value !== "on" && value !== "off") throw new Error("Use /home startup on|off");
        await atomicJson(p.config, { ...config, startup: value === "on" });
        ctx.ui.notify(`Home startup ${value}. Applies on the next launch or /reload.`, "info"); return;
      }
      if (arg === "undo") { const path = await store.restore(); ctx.ui.notify(`Restored ${safeText(path)}`, "info"); return; }
      const state = initialState();
      if (arg === "workspaces" || arg === "artifacts" || arg === "artifacts all") {
        const cwd = await openInventory(ctx, p, store, arg === "workspaces", arg === "artifacts all" ? undefined : ctx.cwd);
        if (cwd === undefined) return;
        state.cwdFilter = cwd;
      } else if (arg === "sessions" || arg === "trash" || arg === "diagnostics" || arg === "models" || arg === "projects" || arg === "tools") state.view = arg;
      else if (arg) { state.range = parseRange(arg).label; state.view = "models"; }
      await openHome(ctx, p, store, state);
    } catch (err: any) { ctx.ui.notify(safeText(err.message || String(err)), "error"); }
  };
  pi.registerCommand("home", { description: "Session browser. /home [sessions|workspaces|artifacts|trash|diagnostics|resources|models|projects|tools|today|7d|all|undo|startup on|off]", handler: home });
  pi.registerCommand("workspaces", { description: "Choose a recorded cwd, then browse its sessions. Header metadata only until a workspace is selected.",
    handler: async (args, ctx) => {
      if (args.trim()) { ctx.ui.notify("Use /workspaces, then / to search cwd.", "error"); return; }
      await home("workspaces", ctx);
    } });
  pi.registerCommand("artifacts", { description: "Read-only session/artifact/cache/trash distribution. /artifacts [all]. No file deletion.",
    handler: async (args, ctx) => {
      if (args.trim() && args.trim() !== "all") { ctx.ui.notify("Use /artifacts or /artifacts all. Inventory is read-only.", "error"); return; }
      await home(args.trim() === "all" ? "artifacts all" : "artifacts", ctx);
    } });
  pi.registerCommand("delete", {
    description: "Confirm, leave this session, then move it to recoverable trash. /delete undo restores the last deletion.",
    handler: async (args, ctx) => {
      if (args.trim() === "undo") return home("undo", ctx);
      if (ctx.mode !== "tui") { ctx.ui.notify("/delete requires interactive TUI mode.", "error"); return; }
      if (args.trim()) { ctx.ui.notify("Use /delete (current session) or /delete undo.", "error"); return; }
      try { const config = await loadConfig(p); await deleteCurrent(ctx, new TrashStore(p, sessionRoots(p, config, ctx.sessionManager.getSessionDir()), config.recursiveSessionRoots)); }
      catch (err: any) { ctx.ui.notify(safeText(err.message || String(err)), "error"); }
    },
  });
}

async function openInventory(ctx: ExtensionCommandContext, p: Paths, store: TrashStore, browse: boolean, cwd: string | undefined): Promise<string | undefined> {
  const state = inventoryState(cwd ?? ctx.cwd, browse);
  state.cwd = cwd;
  while (true) {
    requireIdle(ctx);
    const action = await ctx.ui.custom<InventoryAction>((tui, theme, _kb, done) => {
      const controller = new AbortController();
      const panel = new InventoryPanel({ state, currentCwd: ctx.cwd, browse, theme, done,
        height: () => Math.max(6, Math.floor(tui.terminal.rows * .9)) });
      void scanInventory(p, store.roots, { ...store.discovery, cwd: ctx.cwd,
        sessionDir: ctx.sessionManager.getSessionDir(), sessionFile: ctx.sessionManager.getSessionFile(),
        tempRoot: subagentTempRoot(), signal: controller.signal,
      }).then(result => {
        if (!controller.signal.aborted) { panel.setInventory(result); tui.requestRender(); }
      }).catch((err: any) => {
        if (!controller.signal.aborted) { panel.error = safeText(err.message || String(err)); tui.requestRender(); }
      });
      return { get focused() { return panel.focused; }, set focused(value: boolean) { panel.focused = value; },
        render: (width: number) => panel.render(width), invalidate: () => panel.invalidate(),
        handleInput(data: string) { panel.handleInput(data); tui.requestRender(); }, dispose() { controller.abort(); } };
    }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "95%", anchor: "center" } });
    if (action.kind === "close") return undefined;
    if (action.kind === "sessions") return action.cwd;
    // Refresh uses a fresh, bounded scan; no inventory cache is written.
  }
}

async function openHome(ctx: ExtensionCommandContext, p: Paths, store: TrashStore, state: HomeState): Promise<void> {
  let message = "", reload = true;
  let sessions: Session[] = [], trashed: Session[] = [], active = new Set<string>();
  let indexedStatus = "";
  let diagnostics: Diagnostic[] = [], operationDiagnostics: Diagnostic[] = [], scanSummary: string[] = [];
  let indexedFiles: Awaited<ReturnType<typeof refreshCache>>["cache"]["files"] = {};
  while (true) {
    requireIdle(ctx);
    if (reload) {
      const scan = await refreshCache(store.roots, p.cache, store.discovery);
      const trash = await store.inspect();
      sessions = scan.sessions; indexedFiles = scan.cache.files; trashed = trash.records.map(r => r.session);
      diagnostics = [...scan.diagnostics, ...trash.diagnostics, ...operationDiagnostics];
      try { active = await activePaths(p); }
      catch (err: any) {
        active = new Set();
        diagnostics.push({ level: "warning", code: "active-registry", path: p.leases, message: `${err.message}. Browsing is available; deletion remains blocked.` });
      }
      const warnings = diagnostics.filter(d => d.level === "warning").length;
      indexedStatus = `${sessions.length} saved · ${trashed.length} trashed · ${scan.reused} cached`;
      if (scan.skipped) indexedStatus += ` · ${scan.skipped} non-session skipped`;
      if (scan.pending) indexedStatus += ` · ${scan.pending} pending`;
      if (warnings) indexedStatus += ` · ${warnings} warnings (i:details)`;
      scanSummary = [`Last scan: ${Math.round(scan.durationMs)} ms · ${scan.reused} reused · ${sessions.length - scan.reused} parsed`,
        `${scan.skipped} non-session files · ${scan.pending} pending files · ${scan.excludedDirectories} out-of-scope directories`,
        "Default root: one cwd level. Custom/current roots: flat. Recursive roots: explicit opt-in.",
        "Statistics include saved sessions in these roots only; no duplicate transcript artifacts.",
        ...store.roots.map(root => `Root: ${root}`)];
      reload = false;
    }
    const action = await ctx.ui.custom<Action>((tui, theme, _kb, done) => {
      const panel = new HomePanel({ sessions, trash: trashed, active, cwd: ctx.cwd,
        current: ctx.sessionManager.getSessionFile(), state, status: message || indexedStatus, diagnostics, scanSummary,
        theme, done, height: () => Math.max(8, Math.floor(tui.terminal.rows * .9) - 2) });
      return {
        get focused() { return panel.focused; }, set focused(value: boolean) { panel.focused = value; },
        render: (width: number) => panel.render(width), invalidate: () => panel.invalidate(),
        handleInput(data: string) { panel.handleInput(data); tui.requestRender(); },
      };
    }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "95%", anchor: "center" } });
    if (action.kind === "close") return;
    message = "";
    try {
      requireIdle(ctx);
      if (action.kind === "refresh") { operationDiagnostics = []; reload = true; continue; }
      if (action.kind === "workspaces" || action.kind === "artifacts") {
        const cwd = await openInventory(ctx, p, store, action.kind === "workspaces", action.cwd);
        if (cwd !== undefined) {
          state.cwdFilter = cwd; state.cwdOnly = false; state.view = "sessions";
          state.selectedPath = undefined; state.selectedTrash = undefined; state.preview = undefined; state.selected = 0;
        }
        continue;
      }
      if (action.kind === "resume" && action.path) {
        if (ctx.sessionManager.getSessionFile() === action.path) return;
        // Return immediately after replacement; never reuse the old command context.
        const result = await ctx.switchSession(action.path);
        if (!result.cancelled) return;
        message = "Session switch cancelled.";
      } else if (action.kind === "delete" && action.path) {
        if (action.path === ctx.sessionManager.getSessionFile()) { message = "Current session protected. Close Home and use /delete to leave it safely first."; continue; }
        const ticket = await store.prepare(action.path);
        const indexed = indexedFiles[action.path];
        if (!indexed || indexed.size !== ticket.identity.size || indexed.mtimeMs !== ticket.identity.mtimeMs || indexed.ino !== ticket.identity.ino) {
          reload = true;
          throw new Error("Session changed since the displayed preview. Refreshing; please inspect it again.");
        }
        if (!await confirmTrash(ctx, ticket)) { message = "Cancelled."; continue; }
        requireIdle(ctx);
        await store.move(ticket, ctx.sessionManager.getSessionFile());
        state.preview = undefined; state.selectedPath = undefined;
        message = "Moved to trash · u to undo."; reload = true;
      } else if (action.kind === "restore") {
        const path = await store.restore(action.id);
        state.preview = undefined; state.selectedPath = path;
        message = `Restored ${safeText(path)}`; reload = true;
      } else if (action.kind === "preview-trash") {
        const record = (await store.inspect()).records.find(r => r.id === action.id);
        if (!record) throw new Error("Trash record disappeared; refresh.");
        const session = await store.read(record);
        trashed = trashed.map(s => s.trashed === record.id ? session : s);
      }
    } catch (err: any) {
      const detail: Diagnostic = { level: "warning", code: action.kind, path: action.path || p.home, message: safeText(err.message || String(err)) };
      if (!operationDiagnostics.some(d => d.code === detail.code && d.path === detail.path && d.message === detail.message)) {
        operationDiagnostics.push(detail); diagnostics.push(detail);
      }
      message = `${action.kind} failed · i:diagnostics · ${detail.message}`;
    }
  }
}
