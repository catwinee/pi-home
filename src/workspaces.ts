import { Input, Key, decodeKittyPrintable, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Palette } from "./heatmap.js";
import { formatBytes, type Inventory, type InventoryLocation, type Workspace } from "./inventory.js";
import { safeLabel } from "./stats.js";

export interface InventoryState {
  view: "workspaces" | "locations" | "detail" | "diagnostics";
  cwd?: string; query: string; selected: number; selectedCwd?: string; locationId?: string; scroll: number;
}
export const inventoryState = (cwd: string, browse = false): InventoryState => ({ view: browse ? "workspaces" : "locations", cwd, selectedCwd: cwd, query: "", selected: 0, scroll: 0 });
export type InventoryAction = { kind: "close" | "refresh" | "sessions"; cwd?: string };
export interface InventoryPanelOptions {
  state: InventoryState; currentCwd: string; browse: boolean; theme: Palette; height(): number;
  done(action: InventoryAction): void;
}
const date = (n: number) => n ? new Date(n).toLocaleString() : "—";
export class InventoryPanel {
  inventory?: Inventory;
  error?: string;
  private input = new Input({ prompt: "cwd > " });
  private editing = false;
  private isFocused = false;
  private page = 1;
  private maxScroll = 0;
  constructor(readonly o: InventoryPanelOptions) {}
  get focused(): boolean { return this.isFocused; }
  set focused(value: boolean) { this.isFocused = value; this.input.focused = value && this.editing; }
  invalidate(): void { this.input.invalidate(); }
  private groups(): Workspace[] {
    return (this.inventory?.workspaces ?? []).filter(w => w.cwd.toLocaleLowerCase().includes(this.o.state.query.toLocaleLowerCase()));
  }
  private locations(): InventoryLocation[] {
    return (this.inventory?.locations ?? []).filter(l => this.o.state.cwd === undefined || l.cwds.includes(this.o.state.cwd));
  }
  private remember(): void {
    const s = this.o.state;
    const list = s.view === "workspaces" ? this.groups() : this.locations();
    s.selected = Math.max(0, Math.min(s.selected, list.length - 1));
    if (s.view === "workspaces") s.selectedCwd = this.groups()[s.selected]?.cwd;
    else if (s.view === "locations") s.locationId = this.locations()[s.selected]?.id;
  }
  setInventory(value: Inventory): void {
    this.inventory = value;
    const s = this.o.state;
    const at = s.view === "workspaces" ? this.groups().findIndex(w => w.cwd === s.selectedCwd) : this.locations().findIndex(l => l.id === s.locationId);
    if (at >= 0) s.selected = at;
    this.remember();
  }
  private toGroups(): void {
    const s = this.o.state; s.view = "workspaces"; s.scroll = 0;
    const at = this.groups().findIndex(w => w.cwd === s.selectedCwd);
    s.selected = Math.max(0, at); this.remember();
  }
  private toLocations(cwd?: string): void {
    const s = this.o.state; s.cwd = cwd; s.view = "locations"; s.selected = 0; s.locationId = undefined; s.scroll = 0; this.remember();
  }
  handleInput(data: string): void {
    const s = this.o.state;
    if (this.editing) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) { this.editing = false; this.input.focused = false; return; }
      this.input.handleInput(data); s.query = this.input.getValue(); s.selected = 0; this.remember(); return;
    }
    const key = decodeKittyPrintable(data) ?? data;
    if (matchesKey(data, Key.escape) || key === "q" || matchesKey(data, Key.ctrl("c"))) {
      if (s.view === "detail" || s.view === "diagnostics") { s.view = "locations"; s.scroll = 0; }
      else this.o.done({ kind: "close" });
      return;
    }
    if (key === "r") { this.o.done({ kind: "refresh" }); return; }
    if (!this.inventory) return;
    if (key === "i") { s.view = "diagnostics"; s.scroll = 0; return; }
    if (key === "w") { this.toGroups(); return; }
    if (key === "a") { this.toLocations(); return; }
    if (key === "/") { this.toGroups(); this.editing = true; this.input.setValue(s.query); this.input.focused = this.focused; return; }
    if (key === "c") { this.toLocations(this.o.currentCwd); return; }
    if (key === "s") {
      const cwd = s.view === "workspaces" ? this.groups()[s.selected]?.cwd : s.cwd;
      if (cwd !== undefined) this.o.done({ kind: "sessions", cwd });
      return;
    }
    if (s.view === "detail" || s.view === "diagnostics") {
      if (key === "g") s.scroll = 0;
      else if (key === "G") s.scroll = this.maxScroll;
      else if (matchesKey(data, Key.down) || key === "j") s.scroll++;
      else if (matchesKey(data, Key.up) || key === "k") s.scroll--;
      else if (matchesKey(data, Key.pageDown) || key === " ") s.scroll += this.page;
      else if (matchesKey(data, Key.pageUp)) s.scroll -= this.page;
      s.scroll = Math.max(0, Math.min(this.maxScroll, s.scroll)); return;
    }
    if (matchesKey(data, Key.enter)) {
      if (s.view === "workspaces") {
        const cwd = this.groups()[s.selected]?.cwd;
        if (cwd === undefined) return;
        if (this.o.browse) this.o.done({ kind: "sessions", cwd });
        else this.toLocations(cwd);
      } else if (this.locations()[s.selected]) { s.view = "detail"; s.scroll = 0; }
      return;
    }
    const length = s.view === "workspaces" ? this.groups().length : this.locations().length;
    if (key === "g") s.selected = 0;
    else if (key === "G") s.selected = length - 1;
    else if (matchesKey(data, Key.down) || key === "j") s.selected++;
    else if (matchesKey(data, Key.up) || key === "k") s.selected--;
    else if (matchesKey(data, Key.pageDown)) s.selected += this.page;
    else if (matchesKey(data, Key.pageUp)) s.selected -= this.page;
    this.remember();
    // Deliberately no delete, purge, filesystem-open or arbitrary-path action.
  }
  render(width: number): string[] {
    width = Math.max(1, width);
    const height = Math.max(6, this.o.height()), { theme, state: s } = this.o;
    const snapshot = this.inventory;
    const title = theme.fg("mdHeading", s.view === "workspaces" ? "[Workspaces]" : "[Artifacts · read-only]");
    const scope = s.view === "workspaces" ? "Recorded cwd groups · / search" : s.cwd === undefined ? "All locations · known scope + shared data" : `cwd ${safeLabel(s.cwd) || "(empty recorded cwd)"}`;
    const header = [title, theme.fg("dim", scope),
      ...(s.view !== "workspaces" && s.cwd !== undefined && s.cwd !== this.o.currentCwd ? [theme.fg("dim", "Historical cwd: project paths not scanned; storage only.")] : []),
      ...(this.editing ? this.input.render(width) : [])];
    const available = Math.max(1, height - header.length - 3);
    let body: string[] = [];
    if (!snapshot) body = [this.error ? theme.fg("warning", safeLabel(this.error)) : "Scanning bounded metadata… Esc cancels."];
    else if (s.view === "detail" || s.view === "diagnostics") {
      const l = snapshot.locations.find(l => l.id === s.locationId);
      const raw = s.view === "diagnostics" ? ["[Scope / diagnostics]", `Snapshot ${date(snapshot.scannedAt)}`,
        `Budget: ${snapshot.limits.entries} entries / ${snapshot.limits.milliseconds} ms / depth ${snapshot.limits.depth}`,
        "Only session headers + filesystem metadata. No artifact contents, dialogue search, disk writes or delete actions.",
        "Current cwd's known .pi/subagents directories only. Historical cwd paths are grouping labels, not scan targets.",
        "Arbitrary project files, /tmp files, bash outputs, custom plugin paths and provider caches are NOT inventoried.",
        "Session bytes are grouped by header cwd. Storage artifacts are associated by directory, not proven file ownership.",
        "Shared/unassigned data is not charged to each cwd. Sizes are logical bytes per path; do not sum overlapping locations.", "",
        ...snapshot.diagnostics.flatMap(d => [d.code, d.path, d.message, ""]), ...snapshot.scope,
      ] : l ? [l.path, `${l.kind} · ${l.partial ? "PARTIAL / at least " : ""}${formatBytes(l.bytes)} · ${l.files} files · ${l.directories} directories`,
        `Latest mtime ${date(l.modified)} · ${l.symlinks} symlinks skipped · ${l.special} special files skipped`,
        `Associated cwd: ${l.cwds.length ? l.cwds.join(" | ") : "unassigned/shared (no ownership inferred)"}`, l.evidence,
        "Logical file sizes, not disk blocks. Hardlinks count per path. A live snapshot is not a deletion safety check.",
        ...l.notes, "", `Direct entries · largest first (${l.items.length}/${l.itemCount})`,
        ...l.items.flatMap(i => [`${i.kind}${i.partial ? " / not fully scanned" : ""} · ${formatBytes(i.bytes)} · ${i.files} files · ${date(i.modified)}`, `  ${i.path}`]),
      ] : ["Location no longer present. Esc to return; r to refresh."];
      const rows = raw.flatMap(line => wrapTextWithAnsi(safeLabel(line), width));
      this.page = available; this.maxScroll = Math.max(0, rows.length - available); s.scroll = Math.max(0, Math.min(this.maxScroll, s.scroll));
      body = rows.slice(s.scroll, s.scroll + available);
    } else {
      const groups = this.groups(), locations = this.locations();
      const length = s.view === "workspaces" ? groups.length : locations.length;
      this.page = Math.max(1, Math.floor(available / 3));
      const start = Math.max(0, Math.min(s.selected - Math.floor(this.page / 2), length - this.page));
      for (let i = start; i < Math.min(length, start + this.page); i++) {
        const selected = i === s.selected, marker = selected ? "› " : "  ";
        let lines: string[];
        if (s.view === "workspaces") {
          const w = groups[i]!;
          lines = [marker + (safeLabel(w.cwd) || "(empty recorded cwd)") + (w.cwd === this.o.currentCwd ? " [current cwd]" : ""),
            `  ${w.sessions.length} saved · ${formatBytes(w.bytes)} · ${date(w.modified)}`,
            `  storage ${safeLabel(w.storageDirs[0] || "No saved session directory yet")}${w.storageDirs.length > 1 ? ` (+${w.storageDirs.length - 1})` : ""}`];
        } else {
          const l = locations[i]!;
          lines = [marker + safeLabel(l.path),
            `  ${l.kind} · ${l.partial ? "PARTIAL ≥ " : ""}${formatBytes(l.bytes)} · ${l.files} files · ${l.cwds.length > 1 ? "shared storage" : l.cwds.length ? "cwd-associated" : "unassigned/shared"}`,
            `  latest ${date(l.modified)} · Enter: distribution / evidence`];
        }
        body.push(selected ? theme.bg("selectedBg", lines[0]!) : lines[0]!, ...lines.slice(1).map(line => theme.fg("dim", line)));
      }
      if (!length) body = [s.view === "workspaces" ? "No matching cwd." : "No known locations in this cwd scope. a: shared/all locations."];
    }
    const status = snapshot ? `${snapshot.partial ? "PARTIAL · " : ""}${snapshot.visited} entries · ${Math.round(snapshot.durationMs)} ms · ${snapshot.diagnostics.length} diagnostics · i:scope` : "No changes to files or settings.";
    const hint = s.view === "detail" || s.view === "diagnostics" ? "↑↓/PgUp/PgDn scroll · Esc back · r refresh" : s.view === "workspaces"
      ? `Enter:${this.o.browse ? "sessions" : "locations"} /:search a:all i:scope r:scan Esc`
      : "Enter:details w:cwd a:all c:here s:sessions i:scope r:scan Esc";
    const lines = [...header, "", ...body.slice(0, available)];
    while (lines.length < height - 2) lines.push("");
    lines.push(theme.fg("dim", status), theme.fg("dim", hint));
    return lines.slice(0, height).map(l => truncateToWidth(l, width, width > 1 ? "…" : ""));
  }
}
