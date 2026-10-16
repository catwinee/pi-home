import test from "node:test";
import assert from "node:assert/strict";
import { Container, Markdown, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { attachNativeStartup } from "../src/native-startup.js";
import { StartupHeader } from "../src/startup.js";

const palette = { fg: (color: string, s: string) => color === "warning" ? `\x1b[33m${s}\x1b[0m` : s,
  bg: (_: string, s: string) => s, bold: (s: string) => s };
class ThemedText extends Text {
  constructor(readonly build: () => string) { super("", 1, 0); }
  render(width: number) { this.setText(this.build()); return super.render(width); }
}
class NativeHeader extends Text {
  state = { expanded: false };
  onLogoClick = undefined;
  build() { return "▀▀█  v1.2.0\n█▀ █ shortcuts\nPress ctrl+o to show full startup help and loaded resources."; }
  setExpanded(expanded: boolean) { this.state.expanded = expanded; }
}
const border = () => new DynamicBorder(s => s);
const text = (s: string) => new ThemedText(() => s);
function core(note = false, link = "Changelog: https://pi.dev/changelog") {
  return [new Spacer(1), border(), text("Update Available\nNew version 1.3.0 is available. Run pi update"),
    ...(note ? [new Spacer(1), new Markdown("Release note", 1, 0, {} as any), new Spacer(1)] : []), text(link), border()];
}
function packages() {
  return [new Spacer(1), border(), text("Package Updates Available\nPackage updates are available. Run pi update --extensions\nPackages:\n- npm:example\n- git:example"), border()];
}
function fixture() {
  const root = new Container(), doc = new Container(), box = new Container(), resources = new Container(), chat = new Container();
  const native = new NativeHeader(); box.addChild(native);
  doc.addChild(box); doc.addChild(resources); doc.addChild(chat); root.addChild(doc);
  return { root, chat, native };
}
const append = (chat: Container, children: ReturnType<typeof core>) => children.forEach(c => chat.addChild(c));

test("late native results update the same header without a pending banner or extra wide-screen rows", async () => {
  const f = fixture(), header = new StartupHeader(attachNativeStartup(f.root, "1.2.0", true)!, palette);
  header.loading = true;
  const pending = header.render(110);
  assert.doesNotMatch(pending.join("\n"), /update available|Extensions 0↑|Checking|up to date/);
  await new Promise<void>(resolve => setImmediate(resolve));
  append(f.chat, core());
  const ready = header.render(110);
  assert.ok(ready[0]!.includes("v1.2.0\x1b[33m update available: v1.3.0\x1b[0m"));
  assert.equal(ready.length, pending.length);
  assert.equal(ready.findIndex(l => l.includes("[Activity]")), pending.findIndex(l => l.includes("[Activity]")));
  assert.deepEqual(f.chat.render(110), []);
  append(f.chat, packages());
  assert.match(header.render(110).join("\n"), /Extensions 0\x1b\[33m↑\x1b\[0m/);
  assert.deepEqual(f.chat.render(110), []);
  for (const width of [1, 12, 30, 60, 80, 110]) assert.ok(header.render(width).every(l => visibleWidth(l) <= width));
  header.setExpanded(true);
  assert.deepEqual(f.chat.render(110), [], "Ctrl+O does not bring back update boxes");
  header.dispose();
});

test("package-only and core-only updates are independent; release notes and OSC links are folded", () => {
  const f = fixture(), header = new StartupHeader(attachNativeStartup(f.root, "1.2.0", false)!, palette);
  append(f.chat, packages());
  assert.match(header.render(100).join("\n"), /Extensions \?\x1b\[33m↑/);
  assert.doesNotMatch(header.render(100).join("\n"), /update available/);
  append(f.chat, core(true, "Changelog: \x1b]8;;https://pi.dev/changelog\x1b\\https://pi.dev/changelog\x1b]8;;\x1b\\"));
  assert.match(header.render(100).join("\n"), /update available: v1.3.0/);
  assert.deepEqual(f.chat.render(100), []);
  header.dispose();
});

test("only complete known component sequences are hidden; warnings, lookalike prose and unknown formats survive", () => {
  const f = fixture(), header = new StartupHeader(attachNativeStartup(f.root, "1.2.0", true)!, palette);
  f.chat.addChild(text("Warning: update check failed"));
  f.chat.addChild(new Text("Update Available\nNew version 1.3.0 is available. Run pi update", 0, 0));
  const partial = core(); append(f.chat, partial.slice(0, -1));
  assert.match(f.chat.render(110).join("\n"), /Update Available/);
  assert.doesNotMatch(header.render(110).join("\n"), /update available/);
  f.chat.addChild(partial.at(-1)!);
  assert.match(header.render(110).join("\n"), /update available/);
  assert.match(f.chat.render(110).join("\n"), /Warning: update check failed/);
  assert.match(f.chat.render(110).join("\n"), /Update Available/, "ordinary Text is not hidden");
  const unknown = core(false, "Changelog: https://example.test/new-layout"); append(f.chat, unknown);
  assert.ok(unknown.every(c => c.render(110).length > 0));
  header.dispose();
});

test("existing notices are captured once; disposal restores instances and known results survive native chat clearing/reload", () => {
  const f = fixture(), notices = [...core(), ...packages()]; append(f.chat, notices);
  const add = f.chat.addChild, renders = notices.map(c => c.render);
  let header = new StartupHeader(attachNativeStartup(f.root, "1.2.0", true)!, palette);
  assert.deepEqual(f.chat.render(100), []);
  header.dispose(); header.dispose();
  assert.equal(f.chat.addChild, add);
  assert.deepEqual(notices.map(c => c.render), renders);
  assert.match(f.chat.render(100).join("\n"), /Package Updates Available/);
  f.chat.clear();
  header = new StartupHeader(attachNativeStartup(f.root, "1.2.0", true)!, palette);
  assert.match(header.render(100).join("\n"), /update available: v1.3.0/);
  assert.match(header.render(100).join("\n"), /Extensions 0\x1b\[33m↑/);
  header.dispose();
});

test("resource-only bridges and unsupported versions leave notifications native; disposal respects later wrappers", () => {
  const f = fixture(), notices = core(); append(f.chat, notices);
  assert.equal(attachNativeStartup(f.root, "1.3.0", true), undefined);
  const bridge = attachNativeStartup(f.root, "1.2.0", true)!;
  assert.match(f.chat.render(100).join("\n"), /Update Available/);
  bridge.dispose();
  const header = new StartupHeader(attachNativeStartup(f.root, "1.2.0", true)!, palette);
  const replacement = () => ["external render"], add = () => {};
  notices[2]!.render = replacement; f.chat.addChild = add;
  header.dispose();
  assert.equal(notices[2]!.render, replacement);
  assert.equal(f.chat.addChild, add);
});

test("input redraws do not rebuild or rescan captured native notification text", () => {
  const f = fixture(), header = new StartupHeader(attachNativeStartup(f.root, "1.2.0", true)!, palette);
  let builds = 0;
  const notices = core();
  notices[2] = new ThemedText(() => { builds++; return "Update Available\nNew version 1.3.0 is available. Run pi update"; });
  append(f.chat, notices);
  const before = builds;
  for (let i = 0; i < 20; i++) { header.render(100); f.chat.render(100); }
  assert.equal(builds, before);
  header.invalidate();
  assert.match(header.render(100).join("\n"), /update available/);
  header.dispose();
});
