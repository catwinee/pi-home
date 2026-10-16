import { Input, Key, decodeKittyPrintable, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Palette } from "./heatmap.js";
import { aggregate, mergeSessions, formatTokens as tok, formatCost, parseRange, safeText, safeLabel, searchSessions, type Session, type Stats, type Match, type Totals } from "./stats.js";

import type { Diagnostic } from "./discovery.js";

export const views = ["sessions", "models", "projects", "tools", "trash", "diagnostics"] as const;
export type View = typeof views[number];
export interface HomeState {
  view: View; range: string; query: string; allText: boolean; cwdOnly: boolean; cwdFilter?: string;
  selectedPath?: string; selected: number; scroll: number; preview?: string; previewScroll: number;
  showDetails: boolean; previewJumpPending?: boolean; selectedTrash?: string; previewTrash?: string;
}
export const initialState = (): HomeState => ({ view: "sessions", range: "today", query: "", allText: false, cwdOnly: false, selected: 0, scroll: 0, previewScroll: 0, showDetails: false });
export type Action = { kind: "close" | "refresh" | "restore" | "delete" | "resume" | "preview-trash" | "workspaces" | "artifacts"; path?: string; id?: string; cwd?: string };
export interface HomeOptions {
  sessions: Session[]; trash: Session[]; cwd: string; current?: string;
  active: Set<string>; state: HomeState; status: string;
  diagnostics?: Diagnostic[]; scanSummary?: string[];
  theme: Palette; height: () => number; done: (action: Action) => void;
}
export class HomePanel {
  private input = new Input({ prompt: "> " });
  private editing?: "search" | "range";
  private isFocused = false;
  private stats: Stats;
  private matches: Match[] = [];
  private previewLines?: { width: number; path: string; details: boolean; lines: string[]; offsets: Map<number, number> };
  private page = 10;
  private maxScroll = 0;
  constructor(readonly o: HomeOptions) {
    this.stats = this.calculate(o.state.range);
    this.filter();
  }
  get focused(): boolean { return this.isFocused; }
  set focused(v: boolean) { this.isFocused = v; this.input.focused = v && !!this.editing; }
  invalidate(): void { this.previewLines = undefined; this.input.invalidate(); }
  private scope(): string | undefined { return this.o.state.cwdFilter ?? (this.o.state.cwdOnly ? this.o.cwd : undefined); }
  private calculate(range: string): Stats {
    return aggregate(mergeSessions(this.o.sessions, this.o.trash), parseRange(range), this.scope());
  }
  private filter(): void {
    const s = this.o.state;
    this.matches = s.view === "trash"
      ? this.o.trash.filter(session => this.scope() === undefined || session.cwd === this.scope()).map(session => ({ session, snippet: "" }))
      : searchSessions(this.o.sessions, s.query, s.allText, this.scope());
    const selected = s.selectedPath ? this.matches.findIndex(m => m.session.path === s.selectedPath && m.session.trashed === s.selectedTrash) : -1;
    s.selected = Math.max(0, Math.min(selected < 0 ? s.selected : selected, this.matches.length - 1));
    s.selectedPath = this.matches[s.selected]?.session.path;
    s.selectedTrash = this.matches[s.selected]?.session.trashed;
  }
  private setView(view: View): void {
    const s = this.o.state; s.view = view; s.preview = undefined; s.scroll = 0; this.filter();
  }
  private selected(): Session | undefined { return this.matches[this.o.state.selected]?.session; }
  private previewSession(): Session | undefined {
    const s = this.o.state;
    return [...this.o.sessions, ...this.o.trash].find(v => v.path === s.preview && v.trashed === (s.view === "trash" ? s.previewTrash : undefined));
  }
  private finish(kind: Action["kind"], session?: Session): void {
    this.o.done({ kind, path: session?.path, id: session?.trashed });
  }
  private move(delta: number): void {
    const s = this.o.state;
    s.selected = Math.max(0, Math.min(this.matches.length - 1, s.selected + delta));
    s.selectedPath = this.selected()?.path; s.selectedTrash = this.selected()?.trashed;
  }
  handleInput(data: string): void {
    const s = this.o.state;
    if (this.editing) {
      if (matchesKey(data, Key.escape)) { this.editing = undefined; this.input.focused = false; return; }
      if (matchesKey(data, Key.enter)) {
        if (this.editing === "range") {
          try { parseRange(this.input.getValue()); } catch (e: any) { this.o.status = e.message; return; }
          s.range = this.input.getValue(); this.stats = this.calculate(s.range);
        } else { s.query = this.input.getValue(); s.selectedPath = undefined; s.selected = 0; this.filter(); }
        this.editing = undefined; this.input.focused = false; return;
      }
      this.input.handleInput(data);
      if (this.editing === "search") { s.query = this.input.getValue(); s.selectedPath = undefined; s.selected = 0; this.filter(); }
      return;
    }
    const key = decodeKittyPrintable(data) ?? data;
    if (matchesKey(data, Key.escape) || key === "q" || matchesKey(data, Key.ctrl("c"))) {
      if (s.preview) { s.preview = undefined; this.previewLines = undefined; }
      else this.finish("close");
      return;
    }
    if (key === "w") { this.o.done({ kind: "workspaces", cwd: this.scope() ?? this.o.cwd }); return; }
    if (key === "a") { this.o.done({ kind: "artifacts", cwd: this.previewSession()?.cwd ?? this.selected()?.cwd ?? this.scope() ?? this.o.cwd }); return; }
    if (s.preview) {
      if (key === "d" || matchesKey(data, Key.ctrl("d"))) this.finish(s.view === "trash" ? "restore" : "delete", this.previewSession());
      else if (key === "R" && s.view !== "trash") this.finish("resume", this.previewSession());
      else if (key === "x") { s.showDetails = !s.showDetails; s.previewScroll = 0; this.previewLines = undefined; }
      else if (key === "g") s.previewScroll = 0;
      else if (key === "G") s.previewScroll = this.maxScroll;
      else if (matchesKey(data, Key.up) || key === "k") s.previewScroll = Math.max(0, s.previewScroll - 1);
      else if (matchesKey(data, Key.down) || key === "j") s.previewScroll = Math.min(this.maxScroll, s.previewScroll + 1);
      else if (matchesKey(data, Key.pageDown) || key === " ") s.previewScroll = Math.min(this.maxScroll, s.previewScroll + this.page);
      else if (matchesKey(data, Key.pageUp)) s.previewScroll = Math.max(0, s.previewScroll - this.page);
      return;
    }
    if (key === "/") { this.setView("sessions"); this.editing = "search"; this.input.setValue(s.query); this.input.focused = this.focused; return; }
    if (key === "D") { this.editing = "range"; this.input.setValue(s.range); this.input.focused = this.focused; return; }
    if (key === "r") { this.finish("refresh"); return; }
    if (key === "u") { this.finish("restore", s.view === "trash" ? this.selected() : undefined); return; }
    if (matchesKey(data, Key.tab)) { this.setView(views[(views.indexOf(s.view) + 1) % views.length]!); return; }
    const shortcuts: Record<string, View> = { h: "sessions", s: "sessions", m: "models", p: "projects", t: "tools", b: "trash", i: "diagnostics" };
    if (shortcuts[key]) { this.setView(shortcuts[key]!); return; }
    if ("12345".includes(key) && key.length === 1) {
      s.range = ["today", "7d", "30d", "90d", "all"][Number(key) - 1]!;
      this.stats = this.calculate(s.range); s.scroll = 0; return;
    }
    if (key === "c") {
      s.cwdOnly = this.scope() === undefined; s.cwdFilter = undefined; s.selectedPath = undefined; s.selected = 0; this.filter();
      this.stats = this.calculate(s.range); return;
    }
    if (key === "x") { s.allText = !s.allText; this.filter(); return; }
    if (["sessions", "trash"].includes(s.view)) {
      if (matchesKey(data, Key.down) || key === "j") this.move(1);
      else if (matchesKey(data, Key.up) || key === "k") this.move(-1);
      else if (matchesKey(data, Key.pageDown)) this.move(this.page);
      else if (matchesKey(data, Key.pageUp)) this.move(-this.page);
      else if (key === "g") this.move(-this.matches.length);
      else if (key === "G") this.move(this.matches.length);
      else if (key === "d" || matchesKey(data, Key.ctrl("d"))) { if (this.selected() && s.view !== "trash") this.finish("delete", this.selected()); }
      else if (key === "R" && this.selected() && s.view !== "trash") this.finish("resume", this.selected());
      else if (matchesKey(data, Key.enter) && this.selected()) {
        const sel = this.selected()!;
        s.preview = sel.path; s.previewTrash = sel.trashed; s.previewScroll = 0; s.showDetails = s.allText; s.previewJumpPending = true;
        if (sel.trashed && !sel.documents.length) this.finish("preview-trash", sel);
        else this.previewLines = undefined;
      }
    } else {
      if (matchesKey(data, Key.down) || key === "j") s.scroll = Math.min(this.maxScroll, s.scroll + 1);
      else if (matchesKey(data, Key.up) || key === "k") s.scroll = Math.max(0, s.scroll - 1);
      else if (matchesKey(data, Key.pageDown) || key === " ") s.scroll = Math.min(this.maxScroll, s.scroll + this.page);
      else if (matchesKey(data, Key.pageUp)) s.scroll = Math.max(0, s.scroll - this.page);
    }
  }
  private renderPreview(width: number, height: number): string[] {
    const s = this.o.state, session = this.previewSession();
    if (!session) { s.preview = undefined; return ["Session disappeared; refresh."]; }
    const theme = this.o.theme;
    if (!this.previewLines || this.previewLines.width !== width || this.previewLines.path !== session.path || this.previewLines.details !== s.showDetails) {
      const lines: string[] = [], offsets = new Map<number, number>();
      session.documents.forEach((d, i) => {
        if (!s.showDetails && !["user", "assistant"].includes(d.role)) return;
        offsets.set(i, lines.length);
        lines.push(theme.bold(theme.fg(d.role === "user" ? "accent" : "muted", `${d.role.toUpperCase()} · ${d.timestamp ? new Date(d.timestamp).toLocaleString() : "unknown time"} · ${d.id}`)));
        const text = s.showDetails ? `${d.text}${d.extra ? `\n${d.extra}` : ""}` : d.text;
        lines.push(...wrapTextWithAnsi(text || "[no text; x: show tools/thinking]", Math.max(1, width)), "");
      });
      this.previewLines = { width, path: session.path, details: s.showDetails, lines, offsets };
      const match = this.matches.find(m => m.session.path === session.path);
      if (s.previewJumpPending && match?.document !== undefined) s.previewScroll = offsets.get(match.document) || 0;
      s.previewJumpPending = false;
    }
    const header = [theme.bold(safeLabel(session.name)), safeLabel(session.cwd),
      theme.fg("dim", `Read-only · raw history (all branches) · ${s.showDetails ? "all content" : "dialogue only"}`)];
    this.page = Math.max(1, height - header.length - 1);
    this.maxScroll = Math.max(0, this.previewLines.lines.length - this.page);
    s.previewScroll = Math.min(s.previewScroll, this.maxScroll);
    return [...header, ...this.previewLines.lines.slice(s.previewScroll, s.previewScroll + this.page),
      theme.fg("dim", `Lines ${s.previewScroll + 1}–${Math.min(this.previewLines.lines.length, s.previewScroll + this.page)} / ${this.previewLines.lines.length}`)];
  }
  private renderList(width: number, height: number): string[] {
    const s = this.o.state, theme = this.o.theme, lines: string[] = [];
    const per = s.query.trim() && s.view !== "trash" ? 3 : 2;
    this.page = Math.max(1, Math.floor(Math.max(1, height - 1) / per));
    const start = Math.max(0, Math.min(s.selected - Math.floor(this.page / 2), this.matches.length - this.page));
    if (!this.matches.length) return [theme.fg("muted", s.view === "trash" ? "Trash is empty." : "No matching sessions.")];
    for (let i = start; i < Math.min(this.matches.length, start + this.page); i++) {
      const m = this.matches[i]!, session = m.session;
      const users = session.events.reduce((n, e) => n + e.users, 0);
      const active = session.path === this.o.current ? " [current]" : this.o.active.has(session.path) ? " [active]" : "";
      let title = `${i === s.selected ? "›" : " "} ${safeLabel(session.name)}${active}`;
      title = truncateToWidth(title, width);
      if (i === s.selected) title = theme.bg("selectedBg", title);
      lines.push(title, theme.fg("dim", `  ${users} user · ${new Date(session.modified).toLocaleDateString()} · ${safeLabel(session.cwd)}`));
      if (per === 3) lines.push(theme.fg("muted", m.snippet ? `  ${m.snippet}` : ""));
    }
    lines.push(theme.fg("dim", `${s.selected + 1}/${this.matches.length} · Enter:preview  R:resume  ${s.view === "trash" ? "u:restore" : "d:trash"}`));
    return lines;
  }
  render(width: number): string[] {
    width = Math.max(1, width);
    const s = this.o.state, theme = this.o.theme, height = Math.max(8, this.o.height());
    const header = [theme.fg("mdHeading", `[${s.view[0]!.toUpperCase() + s.view.slice(1)}]`) + theme.fg("muted", `  ${s.range} · ${safeLabel(this.scope() ?? "all cwd") || "(empty recorded cwd)"} · local time`),
      views.map((v, i) => { const label = `${["s", "m", "p", "t", "b", "i"][i]}:${v}`; return v === s.view ? theme.bg("selectedBg", label) : theme.fg("dim", label); }).join("  ")];
    if (this.editing) header.push(...this.input.render(width));
    else if (s.view === "sessions") header.push(`Search: ${s.query || "(all)"} · ${s.allText ? "all content" : "dialogue"} · /:edit  x:scope`);
    const footer = s.preview ? `Esc:back  ↑↓/PgUp/PgDn:scroll  x:details  ${s.view === "trash" ? "d:restore" : "R:resume  d:trash"}`
      : "/:search w:cwd a:files c:scope r:refresh u:undo Esc:close";
    const available = Math.max(1, height - header.length - 3);
    let body: string[];
    if (s.preview) body = this.renderPreview(width, available);
    else if (s.view === "sessions" || s.view === "trash") body = this.renderList(width, available);
    else {
      let rows: string[] = [];
      if (s.view === "diagnostics") {
        const diagnostics = this.o.diagnostics ?? [];
        rows = [theme.bold("DIAGNOSTICS · read-only"), ...(this.o.scanSummary ?? []),
          "Warnings mean incomplete data or blocked cleanup. Info entries are not corruption.", "",
          ...(diagnostics.length ? diagnostics.flatMap(d => [theme.fg(d.level === "warning" ? "warning" : "dim", `${d.level.toUpperCase()} · ${safeLabel(d.code)}`), safeText(d.path), safeText(d.message), ""]) : ["No issues found."])];
      } else if (s.view === "tools") {
        rows = this.stats.tools.flatMap(b => [theme.bold(b.key), `  ${b.tools} direct calls · ${b.nestedTools} nested calls · ${b.sessions.size} sessions`]);
        rows.unshift("Direct calls and nested calls are separate; tool errors are observed results.");
      } else {
        const buckets = s.view === "models" ? this.stats.models : this.stats.projects;
        rows = buckets.flatMap(b => [theme.bold(safeText(b.key)), ...usageLines(b).map(l => `  ${l}`), `  ${b.users} user · ${b.assistants} assistant · ${b.tools} tools · ${b.sessions.size} sessions`, ""]);
      }
      if (!rows.length) rows = ["No activity in this range."];
      rows = rows.flatMap(row => wrapTextWithAnsi(row, width));
      this.page = available; this.maxScroll = Math.max(0, rows.length - available); s.scroll = Math.min(s.scroll, this.maxScroll);
      body = rows.slice(s.scroll, s.scroll + available);
    }
    const lines = [...header, "", ...body.slice(0, available)];
    while (lines.length < height - 2) lines.push("");
    lines.push(theme.fg("muted", safeLabel(this.o.status)), theme.fg("dim", footer));
    return lines.slice(0, height).map(l => truncateToWidth(l, width, width > 1 ? "…" : ""));
  }
}
export function usageLines(t: Totals): string[] {
  return [`Input ${tok(t.input)} · Output ${tok(t.output)} · Recorded cost ${formatCost(t.cost)}`,
    `Cache read ${tok(t.cacheRead)} · Cache write ${tok(t.cacheWrite)}${t.unknownUsage ? ` · ${t.unknownUsage} incomplete/missing usage` : ""}`];
}
export function summaryLines(stats: Stats, theme: Palette): string[] {
  const t = stats.totals;
  return [theme.bold(`${stats.newSessions} new sessions · ${stats.activeSessions} active sessions`),
    `${t.users} user messages · ${t.assistants} assistant responses`,
    `${t.tools} tool calls + ${t.nestedTools} nested · ${t.errors} tool errors${t.incompleteNested ? " · nested records incomplete" : ""}`,
    ...usageLines(t)];
}
