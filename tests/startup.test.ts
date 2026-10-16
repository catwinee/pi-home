import test from "node:test";
import assert from "node:assert/strict";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import { attachNativeStartup, countResourceRows } from "../src/native-startup.js";
import { ResourcesPanel, StartupHeader, startupOverview } from "../src/startup.js";
import { aggregate, emptyTotals, parseRange, parseSessionText } from "../src/stats.js";
import { header as sessionHeader, assistant, iso, jsonl, usage } from "./fixtures.js";

const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s };
class NativeText extends Text {
  state = { expanded: false };
  constructor(readonly collapsed: string, readonly expanded = collapsed) { super("", 0, 0); }
  build() { return this.state.expanded ? this.expanded : this.collapsed; }
  setExpanded(v: boolean) { this.state.expanded = v; this.invalidate(); }
  render(width: number) { this.setText(this.build()); return super.render(width); }
}
const coloredTop = "\x1b[38;2;228;138;122m▀▀█\x1b[0m  v1.2.0";
const coloredBottom = "\x1b[34m█▀\x1b[0m \x1b[33m█\x1b[0m ";
class NativeHeader extends NativeText {
  onLogoClick = undefined;
  constructor() { super(`${coloredTop}\n${coloredBottom}escape interrupt · ctrl+o more\nPress ctrl+o to show full startup help and loaded resources.\n\nPi can explain its own features.`,
    `${coloredTop}\n${coloredBottom}escape to interrupt\nctrl+c to clear\nctrl+o to expand\n\nPi can explain its own features.`); }
}
function fixture() {
  const root = new Container(), document = new Container(), headerBox = new Container(), resources = new Container();
  const native = new NativeHeader(); headerBox.addChild(native);
  document.addChild(headerBox); document.addChild(resources); document.addChild(new Container()); root.addChild(document);
  resources.addChild(new NativeText("[Context]\n  a, b.md", "[Context]\n  /work/a, b.md"));
  resources.addChild(new NativeText("[Skills]\n  example", "[Skills]\n  user\n    /skills/example/SKILL.md"));
  resources.addChild(new NativeText("[Prompts]\n  /review", "[Prompts]\n  user\n    /review"));
  resources.addChild(new NativeText("[Extensions]\n  a, b, package", "[Extensions]\n  user\n    /local/a, b.ts\n    npm:example\n      index.ts\n      helper.ts"));
  resources.addChild(new Text("[Extension issues]\n  preserve me", 0, 0));
  return { root, headerBox, resources, native };
}
test("native adapter preserves original colored glyphs/version, substitutes counts, and removes prose", () => {
  const f = fixture(), original = f.resources.render;
  const bridge = attachNativeStartup(f.root, "1.2.0", true)!;
  const header = new StartupHeader(bridge, theme);
  const lines = header.render(110), output = lines.join("\n");
  assert.equal(lines[0], ` ${coloredTop}`);
  assert.ok(lines[1]!.startsWith(` ${coloredBottom}`));
  assert.match(output, /Context 1 · Skills 1 · Extensions 3    \/home resources/);
  assert.match(output, /Press ctrl\+o to show full startup help and loaded resources\./);
  assert.doesNotMatch(output, /escape interrupt|Pi can explain/);
  assert.doesNotMatch(f.resources.render(110).join("\n"), /\[Skills\]|\[Extensions\]/);
  assert.match(f.resources.render(110).join("\n"), /preserve me/);
  header.setExpanded(true);
  assert.match(header.render(110).join("\n"), /escape to interrupt/);
  assert.doesNotMatch(header.render(110).join("\n"), /Pi can explain/);
  assert.match(f.resources.render(110).join("\n"), /\[Extensions\]/);
  header.setExpanded(false); header.dispose(); header.dispose();
  assert.equal(f.resources.render, original);
  assert.match(f.resources.render(110).join("\n"), /\[Skills\]/);
});
test("resource labels are dim gray, counts brighter muted gray, and the native hint keeps its styling", () => {
  const f = fixture();
  const originalBuild = f.native.build.bind(f.native);
  f.native.build = () => originalBuild().replace(/Press [^\n]+/, s => `\x1b[90m${s}\x1b[0m`);
  const palette = { ...theme, fg: (color: string, s: string) => `\x1b[${color === "dim" ? "90" : "37"}m${s}\x1b[0m` };
  const header = new StartupHeader(attachNativeStartup(f.root, "1.2.0", true)!, palette);
  const output = header.render(110).join("\n");
  for (const label of ["Context", "Skills", "Extensions", "/home resources"]) assert.ok(output.includes(`\x1b[90m${label}\x1b[0m`));
  for (const count of ["1", "3"]) assert.ok(output.includes(`\x1b[37m${count}\x1b[0m`));
  assert.ok(output.includes("\x1b[90mPress ctrl+o to show full startup help and loaded resources.\x1b[0m"));
  assert.ok(header.render(60).every(l => visibleWidth(l) <= 60));
  header.dispose();
});
test("unsupported versions, incomplete layouts, and other extensions' custom headers are not modified", () => {
  const f = fixture(), original = f.resources.render;
  assert.equal(attachNativeStartup(f.root, "1.3.0", true), undefined);
  assert.equal(attachNativeStartup(new Container(), "1.2.0", true), undefined);
  f.headerBox.children = [new Text("other extension")];
  assert.equal(attachNativeStartup(f.root, "1.2.0", true), undefined);
  assert.equal(f.resources.render, original);
});
test("late native resource refreshes are reflected; quiet inventory gives unknown, never fabricated zero", () => {
  const f = fixture(); f.resources.clear();
  const bridge = attachNativeStartup(f.root, "1.2.0", true)!;
  f.resources.addChild(new NativeText("[Skills]\n  new", "[Skills]\n  user\n    /new/SKILL.md"));
  assert.equal(bridge.snapshot().sections[0]!.count, 1);
  assert.match(bridge.prefix(100).join("\n"), /Skills 1/);
  bridge.dispose();
  const quiet = attachNativeStartup(f.root, "1.2.0", false)!;
  assert.match(quiet.prefix(100).join("\n"), /Context \? · Skills \? · Extensions \?/);
  assert.equal(quiet.snapshot().available, false); quiet.dispose();
});
test("resource leaf counting tolerates commas/CJK and excludes scope/package headings", () => {
  assert.equal(countResourceRows("Context", "[Context]\n  /a, b.md\n  /中文.md"), 2);
  assert.equal(countResourceRows("Extensions", "[Extensions]\n  user\n    npm:pkg\n      a.ts\n      b.ts\n    /local.ts\n  project\n    git:pkg\n      main.ts"), 4);
  assert.equal(countResourceRows("Skills", "[Skills]\nmalformed"), undefined);
});
test("theme invalidation and replacement resource components are read live, without changing expansion state", () => {
  const f = fixture(), bridge = attachNativeStartup(f.root, "1.2.0", true)!;
  const item = f.resources.children[1] as NativeText;
  item.setExpanded(true); bridge.snapshot(); assert.equal(item.state.expanded, true);
  item.setExpanded(false); bridge.snapshot(); assert.equal(item.state.expanded, false);
  f.resources.children[1] = new NativeText("[Skills]\n  new, second", "[Skills]\n  user\n    new\n    second");
  assert.match(bridge.prefix(100).join("\n"), /Skills 2/); bridge.dispose();
});
test("startup overview uses native bracket headings in one column and preserves all metrics and heatmap", () => {
  const empty = aggregate([], parseRange("today")), data = { today: empty, history: empty, warnings: 0 };
  for (const width of [58, 78, 108, 160]) {
    const lines = startupOverview(data, width, theme), text = lines.join("\n");
    assert.equal(lines[0], "[Today]");
    const activity = lines.indexOf("[Activity]");
    assert.ok(activity > 1);
    assert.equal(lines[activity - 1], "");
    assert.ok(lines.slice(1, activity - 1).every(l => l.startsWith("  ")));
    assert.doesNotMatch(text, /│|TODAY|ACTIVITY/);
    for (const label of ["Sun", "Mon", "Sat", "↑", "↓", "CH R", "W 0", "cost", "/home"]) assert.ok(text.includes(label), `${width}: ${label}`);
    assert.ok(lines.every(l => visibleWidth(l) <= width));
  }
  const styled = startupOverview(data, 100, { ...theme, fg: (color, s) => color === "mdHeading" ? `\x1b[35m${s}\x1b[0m` : s,
    bold: () => { throw new Error("Native section headings are not bold"); } });
  assert.equal(styled[0], "\x1b[35m[Today]\x1b[0m");
  assert.ok(styled.includes("\x1b[35m[Activity]\x1b[0m"));
  const f = fixture(), header = new StartupHeader(attachNativeStartup(f.root, "1.2.0", true)!, theme); header.data = data;
  for (const width of [1, 12, 40, 60, 80, 110]) assert.ok(header.render(width).every(l => visibleWidth(l) <= width));
  header.dispose();
});
test("Today packs counts and usage into two lines on wide screens and wraps without losing fields", () => {
  const stats = aggregate([], parseRange("all"));
  stats.activeSessions = 1;
  Object.assign(stats.totals, { users: 9, assistants: 167, tools: 218, errors: 7, nestedTools: 17, incompleteNested: 2, input: 479000, output: 119000, cacheRead: 21000000, cost: 31.92 });
  const data = { today: stats, history: stats, warnings: 0 };
  const wide = startupOverview(data, 110, theme);
  assert.equal(wide[1], "  messages 9 replies 167 tools 218 errors 7");
  assert.equal(wide[2], "  ↑ 479k ↓ 119k CH R 21M W 0 cost $31.92");
  assert.doesNotMatch(wide.join("\n"), /\bnew\b|\bactive\b|\buser\b|nested/);
  assert.equal(wide[3], "  Models tokens"); assert.equal(wide[4], "  None recorded");
  assert.equal(wide[6], ""); assert.equal(wide[7], "[Activity]");
  const narrow = startupOverview(data, 40, theme), text = narrow.join(" ").replace(/\s+/g, " ");
  for (const field of ["replies 167", "tools 218", "CH R 21M", "W 0", "cost $31.92"]) assert.ok(text.includes(field), field);
  assert.ok(narrow.every(l => visibleWidth(l) <= 40));
  const palette = { ...theme, fg: (color: string, s: string) => `\x1b[${color === "dim" ? "90" : "37"}m${s}\x1b[0m` };
  const colored = startupOverview(data, 110, palette).join("\n");
  for (const name of ["messages", "replies", "tools", "errors", "↑", "↓", "CH R", "W", "cost"]) assert.ok(colored.includes(`\x1b[90m${name}\x1b[0m`), name);
  for (const n of ["9", "167", "218", "7", "479k", "119k", "21M", "0", "$31.92"]) assert.ok(colored.includes(`\x1b[37m${n}\x1b[0m`), n);
  assert.ok(startupOverview(data, 40, palette).every(l => visibleWidth(l) <= 40));
});
test("unattributed zero-token summaries do not produce fake bars; real unattributed usage remains visible", () => {
  for (const withUsage of [false, true]) {
    const session = parseSessionText(jsonl(sessionHeader(), assistant(), { type: "compaction", id: "c", timestamp: iso(), summary: "summary", ...(withUsage ? { usage } : {}) }), "/synthetic.jsonl");
    const stats = aggregate([session], parseRange("all"));
    const output = startupOverview({ today: stats, history: stats, warnings: 0 }, 110, theme).join("\n");
    assert.doesNotMatch(output, /unattributed\/unattributed/);
    if (withUsage) {
      assert.match(output, /Unattributed 100 · 50%/);
      assert.equal(stats.totals.input, 20);
    } else {
      assert.doesNotMatch(output, /Unattributed/);
      assert.match(output, /p\/m 100 · 100%/);
      assert.match(output, /1 records with unknown usage/);
    }
  }
});
test("top model bars use all models as denominator, not just the two displayed models", () => {
  const stats = aggregate([], parseRange("all"));
  stats.models = [50, 30, 20].map((input, i) => ({ ...emptyTotals(), input, key: `p/m${i}`, sessions: new Set<string>() }));
  const output = startupOverview({ today: stats, history: stats, warnings: 0 }, 110, theme).join("\n");
  assert.match(output, /Models tokens \(top 2\)/);
  assert.match(output, /p\/m0 50 · 50%/); assert.match(output, /p\/m1 30 · 30%/);
  assert.doesNotMatch(output, /p\/m2/);
});
test("compact and overview headers omit redundant workspace and inventory hints", () => {
  const f = fixture(), header = new StartupHeader(attachNativeStartup(f.root, "1.2.0", true)!, theme);
  for (const loading of [false, true]) {
    header.loading = loading;
    const text = header.render(100).join("\n");
    assert.doesNotMatch(text, /\[Workspace\]|cwd |\/workspaces|\/artifacts|0 artifacts|0 sessions/);
    assert.equal(text.includes("[Today]"), loading);
    assert.equal(text.includes("[Activity]"), loading);
  }
  for (const width of [1, 20, 60]) assert.ok(header.render(width).every(l => visibleWidth(l) <= width));
  header.dispose();
});
test("pending startup renders honest placeholders with the same section geometry as ready data", () => {
  const stats = aggregate([], parseRange("all"));
  Object.assign(stats.totals, { users: 12000, assistants: 12000, tools: 24000, errors: 17, input: 479000, output: 119000, cacheRead: 21000000, cost: 31.92 });
  stats.models = [50, 30, 20].map((input, i) => ({ ...emptyTotals(), input, key: `provider/very-long-model-name-${i}-中文`, sessions: new Set<string>() }));
  for (const width of [40, 58, 78, 108, 160]) {
    const pending = startupOverview(undefined, width, theme), text = pending.join("\n");
    assert.match(text, /messages — replies —/);
    assert.doesNotMatch(text, /Loading|messages 0|cost \$0|[░▒▓█]/u);
    assert.match(text, /Sun (?:— )+/);
    for (const models of [[], stats.models.slice(0, 1), stats.models]) {
      const ready = startupOverview({ today: { ...stats, models }, history: stats, warnings: 0 }, width, theme);
      assert.equal(pending.length, ready.length, `height at ${width}`);
      assert.equal(pending.indexOf("[Activity]"), ready.indexOf("[Activity]"), `activity at ${width}`);
      assert.equal(pending.findIndex(l => l.includes("Sun ")), ready.findIndex(l => l.includes("Sun ")));
    }
    assert.ok(pending.every(l => visibleWidth(l) <= width));
  }
});
test("loading, errors, resize and theme changes preserve a usable header without animated loading text", () => {
  const f = fixture(), header = new StartupHeader(attachNativeStartup(f.root, "1.2.0", true)!, theme);
  header.loading = true;
  for (const width of [1, 12, 40, 60, 80, 110]) assert.ok(header.render(width).every(l => visibleWidth(l) <= width));
  const pending = header.render(110);
  for (const label of ["[Today]", "[Activity]", "Sat", "messages —"]) assert.ok(pending.join("\n").includes(label));
  assert.doesNotMatch(pending.join("\n"), /Loading local activity/);
  header.setExpanded(true); assert.match(header.render(110).join("\n"), /escape to interrupt/);
  header.setExpanded(false); header.invalidate(); assert.deepEqual(header.render(110), pending);
  header.loading = false; header.error = "Unable to scan";
  assert.match(header.render(110).join("\n"), /Unable to scan.*\/home to retry/);
  assert.match(header.render(110).join("\n"), /messages —/);
  header.dispose();
});
test("input redraws reuse the overview layout; data, width and theme invalidation rebuild it", () => {
  const f = fixture(); let overviews = 0, tone = "";
  const palette = { ...theme, fg: (_: string, s: string) => { if (s === "[Today]") overviews++; return tone + s; } };
  const header = new StartupHeader(attachNativeStartup(f.root, "1.2.0", true)!, palette);
  header.loading = true;
  header.render(110); header.render(110); assert.equal(overviews, 1);
  // Live resource counts must not be frozen along with the static body.
  f.resources.children[1] = new NativeText("[Skills]\n  new", "[Skills]\n  user\n    one\n    two");
  assert.match(header.render(110).join("\n"), /Skills 2/); assert.equal(overviews, 1);
  header.render(80); assert.equal(overviews, 2);
  const stats = aggregate([], parseRange("all"));
  header.data = { today: stats, history: stats, warnings: 0 }; header.loading = false;
  assert.match(header.render(80).join("\n"), /messages 0/); assert.equal(overviews, 3);
  tone = "~"; header.invalidate();
  assert.match(header.render(80).join("\n"), /~\[Today\]/); assert.equal(overviews, 4);
  header.dispose();
});
test("resources panel scrolls to the final entry and closes without notifications or transcript insertion", () => {
  let closed = false;
  const panel = new ResourcesPanel(() => ({ available: true, sections: [{ name: "Skills", count: 60, text: "[Skills]\n" + Array.from({ length: 60 }, (_, i) => `skill-${i}`).join("\n") }] }), theme, () => 12, () => { closed = true; });
  assert.doesNotMatch(panel.render(60).join("\n"), /skill-59/);
  panel.handleInput("G"); assert.match(panel.render(60).join("\n"), /skill-59/);
  panel.handleInput("g"); assert.match(panel.render(60).join("\n"), /skill-0/);
  panel.handleInput("q"); assert.ok(closed);
});
