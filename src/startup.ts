import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { heatmap, type Palette } from "./heatmap.js";
import { formatCost, formatTokens as tok, safeLabel, tokenTotal, type Stats } from "./stats.js";
import { resourceSummary, type NativeStartupBridge, type ResourceSnapshot } from "./native-startup.js";

export interface StartupData { today: Stats; history: Stats; warnings: number }
/** Shared pending/ready layout: no invented zeroes, spinner, or collapsed loading screen.
 * Reserve ordinary metric widths and two model rows; unusually large values/warnings may grow.
 * Never drop the heatmap or cache usage just because a terminal is short.
 */
export function startupOverview(data: StartupData | undefined, width: number, theme: Palette): string[] {
  const t = data?.today.totals, inner = Math.max(1, width - 2);
  const title = (s: string) => theme.fg("mdHeading", `[${s}]`);
  const label = (text: string) => theme.fg("dim", text);
  const value = (text: string | number) => theme.fg("muted", String(text));
  const field = (name: string, n: string | number) => `${label(name)} ${value(n)}`;
  const metrics = [
    [field("messages", t?.users ?? "—"), field("replies", t?.assistants ?? "—"), field("tools", t?.tools ?? "—"), field("errors", t?.errors ?? "—")].join(" "),
    [field("↑", t ? tok(t.input) : "—"), field("↓", t ? tok(t.output) : "—"), field("CH R", t ? tok(t.cacheRead) : "—"), field("W", t ? tok(t.cacheWrite) : "—"), field("cost", t ? formatCost(t.cost) : "—")].join(" ")];
  const metricTemplates = ["messages 999999 replies 999999 tools 999999 errors 999999", "↑ 999.9M ↓ 999.9M CH R 999.9M W 999.9M cost $9999.99"];
  // A missing-usage summary can have a model bucket but no recorded tokens. Do not draw
  // a minimum-length bar for it; unknown usage remains explicitly reported below.
  const tokenModels = data?.today.models.filter(m => tokenTotal(m) > 0) ?? [];
  const models = tokenModels.slice(0, 2);
  const total = tokenModels.reduce((n, m) => n + tokenTotal(m), 0);
  const bars = models.map(m => {
    const n = tokenTotal(m), percent = 100 * n / total;
    const size = Math.round(7 * n / total);
    const name = m.key === "unattributed/unattributed" ? "Unattributed" : safeLabel(m.key);
    const share = percent < .1 ? "<0.1" : percent.toFixed(1).replace(/\.0$/, "");
    const nameWidth = Math.max(1, inner - visibleWidth(`───────  ${tok(n)} · ${share}%`));
    return `${theme.fg("success", "━".repeat(size))}${label("─".repeat(7 - size))} ${label(truncateToWidth(name, nameWidth, "…"))} ${value(tok(n))}${label(" · ")}${value(`${share}%`)}`;
  });
  const indent = (line: string, template = line) => {
    const rows = wrapTextWithAnsi(line, inner);
    while (rows.length < wrapTextWithAnsi(template, inner).length) rows.push("");
    return rows.map(row => `  ${row}`);
  };
  const lines = [title("Today"), ...metrics.flatMap((line, i) => indent(line, metricTemplates[i])),
    ...indent(label(`Models tokens${tokenModels.length > 2 ? " (top 2)" : ""}`), "Models tokens (top 2)")];
  for (let i = 0; i < 2; i++) {
    const row = bars[i] ?? label(!data ? "—" : i === 0 ? "None recorded" : "");
    lines.push(...indent(row, "─────── — 999.9M · 100%"));
  }
  if (t?.unknownUsage) lines.push(theme.fg("warning", `  ${t.unknownUsage} records with unknown usage`));
  lines.push("", title("Activity"), ...heatmap(data?.history.daily, inner, theme).map(line => `  ${line}`),
    theme.fg("muted", "/home · sessions / search / preview / trash"));
  if (data?.warnings) lines.push(theme.fg("warning", `${data.warnings} scan warnings · /home diagnostics`));
  return lines.map(l => truncateToWidth(l, width, width > 1 ? "…" : ""));
}

export class StartupHeader implements Component {
  data?: StartupData;
  loading = false;
  error?: string;
  private expanded = false;
  private overviewCache?: { width: number; data: StartupData | undefined; lines: string[] };
  disposed = false;
  constructor(readonly bridge: NativeStartupBridge, readonly theme: Palette) { bridge.observeUpdates(); }
  setExpanded(value: boolean): void { this.expanded = value; this.bridge.setExpanded(value); }
  invalidate(): void { this.overviewCache = undefined; this.bridge.original.invalidate(); }
  dispose(): void { this.disposed = true; this.overviewCache = undefined; this.bridge.dispose(); }
  handleMouse: Component["handleMouse"] = event => this.bridge.original.handleMouse?.(event);
  render(width: number): string[] {
    const lines = this.bridge.prefix(width, this.theme);
    if (this.expanded) lines.push("", ...this.bridge.help(width));
    if (this.data || this.loading || this.error) {
      // Input redraws need not rebuild a static calendar. Native resources above stay live.
      if (!this.overviewCache || this.overviewCache.width !== width || this.overviewCache.data !== this.data)
        this.overviewCache = { width, data: this.data, lines: startupOverview(this.data, Math.max(1, width - 2), this.theme).map(l => ` ${l}`) };
      lines.push("", ...this.overviewCache.lines);
    }
    if (this.error) lines.push(this.theme.fg("warning", ` ${safeLabel(this.error)} · /home to retry`));
    return lines.map(l => truncateToWidth(l, width, width > 1 ? "…" : ""));
  }
}

/** Read-only inventory. Long inventories are scrollable rather than inserted into the transcript. */
export class ResourcesPanel implements Component {
  private scroll = 0;
  private page = 1;
  private max = 0;
  constructor(readonly snapshot: () => ResourceSnapshot, readonly theme: Palette, readonly height: () => number, readonly done: () => void) {}
  invalidate(): void {}
  handleInput(key: string): void {
    if (matchesKey(key, Key.escape) || key === "q" || matchesKey(key, Key.ctrl("c"))) this.done();
    else if (key === "g") this.scroll = 0;
    else if (key === "G") this.scroll = this.max;
    else if (key === "j" || matchesKey(key, Key.down)) this.scroll++;
    else if (key === "k" || matchesKey(key, Key.up)) this.scroll--;
    else if (key === " " || matchesKey(key, Key.pageDown)) this.scroll += this.page;
    else if (matchesKey(key, Key.pageUp)) this.scroll -= this.page;
    this.scroll = Math.max(0, Math.min(this.max, this.scroll));
  }
  render(width: number): string[] {
    const snapshot = this.snapshot();
    const body = resourceSummary(snapshot).flatMap(s => wrapTextWithAnsi(s, Math.max(1, width - 2)));
    this.page = Math.max(1, this.height() - 3); this.max = Math.max(0, body.length - this.page);
    this.scroll = Math.max(0, Math.min(this.max, this.scroll));
    return [this.theme.bold(this.theme.fg("accent", "Loaded resources · native Pi inventory")), "",
      ...body.slice(this.scroll, this.scroll + this.page),
      this.theme.fg("muted", `↑↓ / PgUp PgDn · ${this.scroll + 1}–${Math.min(body.length, this.scroll + this.page)}/${body.length} · Esc close`),
    ].map(l => truncateToWidth(l, width, width > 1 ? "…" : ""));
  }
}
