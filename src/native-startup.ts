/** Pi 1.2.0 compatibility boundary. No module/prototype patches, resource rescans or core file edits.
 * We reuse native components to keep the exact logo, theme, keybindings and loaded-resource list.
 * Everything outside this module uses public extension/TUI APIs. Unsupported layouts are left alone.
 */
import type { Component } from "@earendil-works/pi-tui";
import { sliceByColumn, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { safeLabel } from "./stats.js";
import type { Palette } from "./heatmap.js";

interface NativeText extends Component {
  build(): string;
  state: { expanded: boolean };
  setExpanded(expanded: boolean): void;
  onLogoClick?: unknown;
}
interface NativeContainer extends Component { children: Component[]; addChild(component: Component): void }
export interface ResourceSection { name: string; text: string; count?: number }
export interface ResourceSnapshot { sections: ResourceSection[]; available: boolean; reason?: string }
const sections = new Set(["Context", "Skills", "Prompts", "Extensions"]);
const strip = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const isContainer = (c: any): c is NativeContainer => !!c && Array.isArray(c.children) && typeof c.render === "function";
const isNativeText = (c: any): c is NativeText => !!c && typeof c.build === "function" && typeof c.setExpanded === "function" && typeof c.state?.expanded === "boolean";
function buildAt(c: NativeText, expanded: boolean): string {
  const was = c.state.expanded;
  try { c.setExpanded(expanded); return c.build(); }
  finally { c.setExpanded(was); }
}
function sectionName(c: Component): string | undefined {
  if (!isNativeText(c)) return undefined;
  const name = /^\[([^\]\n]+)\]/.exec(strip(c.build()))?.[1];
  return name && sections.has(name) ? name : undefined;
}
/** Count expanded native leaf rows, not comma-separated labels (paths can contain commas). */
export function countResourceRows(name: string, text: string): number | undefined {
  const lines = strip(text).split("\n").slice(1).filter(l => l.trim());
  if (name === "Context") return lines.every(l => /^  \S/.test(l)) ? lines.length : undefined;
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const indent = /^ */.exec(lines[i]!)![0].length;
    if (indent === 2) continue; // scope heading
    if (indent === 6) { count++; continue; } // package resource
    if (indent === 4) {
      // Package source headings have nested leaves; plain sources have no nested row.
      if (!/^ {6}\S/.test(lines[i + 1] || "")) count++;
      continue;
    }
    return undefined;
  }
  return count;
}

interface UpdateState { version?: string; packages: boolean }
// The native header survives /new, /resume and extension-runtime replacement on /reload.
// Keep only the two positive results in memory, not a timer, network client or disk cache.
const updateStateKey = Symbol.for("pi-home.native-updates.v1");
const hiddenUpdateRender = (_width: number): string[] => [];
const nativeKind = (c: Component | undefined, name: string) => c?.constructor.name === name;
const spacer = (c: Component | undefined) => nativeKind(c, "Spacer") && (c as any).lines === 1;
function updateText(c: Component | undefined): string | undefined {
  if (!nativeKind(c, "ThemedText") || typeof (c as any).build !== "function") return;
  // Native changelog links may use OSC 8. Never render any parsed arbitrary notification text.
  return strip((c as any).build()).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}
/** Recognize complete Pi 1.2.0 notification component sequences, never matching chat prose.
 * Unknown formats (including future native changes) remain visible in full.
 */
function updateBlock(children: Component[], end: number): { start: number; version?: string; packages?: true } | undefined {
  if (!nativeKind(children[end], "DynamicBorder")) return;
  const packageStart = end - 3;
  if (spacer(children[packageStart]) && nativeKind(children[packageStart + 1], "DynamicBorder")) {
    const text = updateText(children[packageStart + 2]);
    if (text && /^Package Updates Available\nPackage updates are available\. Run pi update --extensions\nPackages:\n- [^\n]+(?:\n- [^\n]+)*$/.test(text))
      return { start: packageStart, packages: true };
  }
  for (const hasNote of [false, true]) {
    const start = end - (hasNote ? 7 : 4);
    if (!spacer(children[start]) || !nativeKind(children[start + 1], "DynamicBorder")) continue;
    const text = updateText(children[start + 2]);
    const version = text && /^Update Available\nNew version (v?\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?) is available\. Run pi update$/.exec(text)?.[1];
    if (!version || version.length > 100 || updateText(children[end - 1]) !== "Changelog: https://pi.dev/changelog") continue;
    if (hasNote && !(spacer(children[start + 3]) && nativeKind(children[start + 4], "Markdown") && spacer(children[start + 5]))) continue;
    return { start, version: version.replace(/^v/, "") };
  }
  return undefined;
}
function observeNativeUpdates(chat: NativeContainer, header: NativeText): { state: UpdateState; dispose(): void } | undefined {
  if (typeof chat.addChild !== "function") return;
  const owner = header as NativeText & { [updateStateKey]?: UpdateState };
  const state = owner[updateStateKey] ?? { packages: false };
  if (!owner[updateStateKey]) Object.defineProperty(owner, updateStateKey, { value: state, configurable: true });
  const renders = new Map<Component, { render: Component["render"]; own: boolean }>();
  const capture = (end: number) => {
    let block: ReturnType<typeof updateBlock>;
    try { block = updateBlock(chat.children, end); }
    catch { return; } // A foreign/malformed component must not break native addChild.
    if (!block) return;
    if (block.version) state.version = block.version;
    if (block.packages) state.packages = true;
    for (let i = block.start; i <= end; i++) {
      const c = chat.children[i]!;
      if (!renders.has(c)) {
        renders.set(c, { render: c.render, own: Object.hasOwn(c, "render") });
        c.render = hiddenUpdateRender;
      }
    }
  };
  // Capture already-present notices once. New notices arrive through native addChild; examine
  // at most eight trailing components per append, with no transcript scan on input redraws.
  for (let i = 0; i < chat.children.length; i++) capture(i);
  const originalAdd = chat.addChild, hadOwnAdd = Object.hasOwn(chat, "addChild");
  let disposed = false;
  const add = (component: Component) => {
    originalAdd.call(chat, component);
    if (!disposed) capture(chat.children.length - 1);
    // Native notification methods request a render after the complete synchronous batch.
  };
  chat.addChild = add;
  return { state, dispose() {
    if (disposed) return; disposed = true;
    if (chat.addChild === add) {
      if (hadOwnAdd) chat.addChild = originalAdd;
      else delete (chat as Partial<NativeContainer>).addChild;
    }
    for (const [c, original] of renders) {
      if (c.render === hiddenUpdateRender) {
        if (original.own) c.render = original.render;
        else delete (c as Partial<Component>).render;
        c.invalidate();
      }
    }
    renders.clear();
    chat.invalidate();
  } };
}

export interface NativeStartupBridge {
  original: NativeText;
  snapshot(): ResourceSnapshot;
  observeUpdates(): void;
  setExpanded(value: boolean): void;
  prefix(width: number, theme?: Pick<Palette, "fg">): string[];
  help(width: number): string[];
  dispose(): void;
}
export function attachNativeStartup(tui: unknown, version: string, listingEnabled: boolean): NativeStartupBridge | undefined {
  if (version !== "1.2.0") return undefined;
  const seen = new Set<unknown>();
  function find(node: any, depth: number): { header: NativeText; resources: NativeContainer; chat: NativeContainer } | undefined {
    if (depth > 8 || seen.size > 200 || !isContainer(node) || seen.has(node)) return;
    seen.add(node);
    // Pi's document consists of header, loaded resources, and transcript containers.
    if (node.children.length === 3 && node.children.every(isContainer)) {
      const headerContainer = node.children[0] as NativeContainer;
      const header = headerContainer.children.find(c => isNativeText(c) && "onLogoClick" in c);
      if (header && isNativeText(header)) {
        const text = strip(buildAt(header, false));
        if (/v1\.2\.0/.test(text) && /Press .+ to show full startup help/.test(text))
          return { header, resources: node.children[1] as NativeContainer, chat: node.children[2] as NativeContainer };
      }
    }
    for (const child of node.children) { const found = find(child, depth + 1); if (found) return found; }
    return undefined;
  }
  const found = find(tui, 0);
  if (!found) return undefined;
  const { header, resources, chat } = found;
  let expanded = false, disposed = false;
  let updates: ReturnType<typeof observeNativeUpdates>;
  const originalRender = resources.render;
  const hadOwnRender = Object.hasOwn(resources, "render");
  const foldedRender = (width: number): string[] => {
    if (expanded || disposed) return originalRender.call(resources, width);
    // Preserve all warnings/conflicts and unknown future sections. Only ordinary inventory is folded.
    const lines = resources.children.filter(c => !sectionName(c)).flatMap(c => c.render(width));
    while (lines.length && !strip(lines[0]!).trim()) lines.shift();
    while (lines.length && !strip(lines[lines.length - 1]!).trim()) lines.pop();
    return lines;
  };
  resources.render = foldedRender;
  const snapshot = (): ResourceSnapshot => {
    const result: ResourceSection[] = [];
    for (const c of resources.children) {
      const name = sectionName(c);
      if (name && isNativeText(c)) {
        const text = buildAt(c, true);
        result.push({ name, text, count: countResourceRows(name, text) });
      } else {
        const text = typeof (c as any).build === "function" ? (c as any).build() : undefined;
        if (typeof text === "string" && /^\[/.test(strip(text))) result.push({ name: "Diagnostics", text });
      }
    }
    return { sections: result, available: listingEnabled,
      reason: listingEnabled ? undefined : "Pi quietStartup hides the native inventory. Counts are unknown; set quietStartup to false to expose the inventory for folding." };
  };
  return {
    original: header, snapshot,
    // Resource-only overlays must never suppress notifications without a replacement header.
    observeUpdates() { if (!disposed && !updates) updates = observeNativeUpdates(chat, header); },
    setExpanded(value) { expanded = value; header.setExpanded(value); },
    prefix(width, theme) {
      const raw = buildAt(header, false).split("\n");
      const logo = /^▀▀█/.test(strip(raw[0] || ""));
      const data = snapshot();
      const count = (name: string) => data.available ? String(data.sections.find(s => s.name === name)?.count ?? (data.sections.some(s => s.name === name) ? "?" : 0)) : "?";
      const fg = (color: "dim" | "muted" | "warning", text: string) => theme ? theme.fg(color, text) : text;
      const counts = ["Context", "Skills", "Extensions"].map(name => `${fg("dim", name)} ${fg("muted", count(name))}${name === "Extensions" && updates?.state.packages ? fg("warning", "↑") : ""}`).join(fg("dim", " · "))
        + (width < 70 ? "  " : "    ") + fg("dim", "/home resources");
      const prefix = logo ? sliceByColumn(raw[1] || "", 0, 5) : "";
      // Keep the native hint's ANSI styling instead of stripping it to terminal-default white.
      const hint = raw.find(l => strip(l).startsWith("Press ")) || fg("dim", "Press ctrl+o to show full startup help and loaded resources.");
      const inner = Math.max(1, width - 2);
      const top = raw[0] || "Pi v1.2.0";
      const topLines = updates?.state.version
        ? wrapTextWithAnsi(top + fg("warning", ` update available: v${updates.state.version}`), inner).map(l => ` ${l}`)
        : [truncateToWidth(` ${top}`, width, "")];
      return [...topLines,
        ...wrapTextWithAnsi(prefix + counts, inner).map(l => ` ${l}`),
        ...wrapTextWithAnsi(hint, inner).map(l => ` ${l}`)];
    },
    help(width) {
      const raw = buildAt(header, true).split("\n");
      const logo = /^▀▀█/.test(strip(raw[0] || ""));
      const lines = [logo ? sliceByColumn(raw[1] || "", 5, 10000) : (raw[1] || ""), ...raw.slice(2)];
      const stop = lines.findIndex(l => !strip(l).trim() || strip(l).startsWith("Pi can explain"));
      return (stop < 0 ? lines : lines.slice(0, stop)).flatMap(l => wrapTextWithAnsi(l, Math.max(1, width - 2)).map(row => ` ${row}`));
    },
    dispose() {
      if (disposed) return; disposed = true;
      updates?.dispose();
      if (resources.render === foldedRender) {
        if (hadOwnRender) resources.render = originalRender;
        else delete (resources as Partial<NativeContainer>).render;
      }
      resources.invalidate();
    },
  };
}
export function resourceSummary(snapshot: ResourceSnapshot): string[] {
  if (!snapshot.available) return [snapshot.reason || "Native resource inventory is unavailable in this Pi layout."];
  return snapshot.sections.length ? snapshot.sections.flatMap(s => [s.text, ""]) : ["No loaded resources are listed by Pi."];
}
export const unavailableResources = (reason: string): ResourceSnapshot => ({ sections: [], available: false, reason: safeLabel(reason) });
