import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HomePanel, initialState, views, type Action } from "../src/home.js";
import { parseSessionText } from "../src/stats.js";
import { sample } from "./fixtures.js";
const theme = { fg: (_: unknown, s: string) => s, bg: (_: unknown, s: string) => s, bold: (s: string) => s };
function panel(height = 30) {
  const sessions = Array.from({ length: 30 }, (_, i) => { const s = parseSessionText(sample(String(i)), `/s/${i}.jsonl`); s.modified += i; return s; });
  const state = initialState(), actions: Action[] = [];
  const p = new HomePanel({ sessions, trash: [], active: new Set(), cwd: "/work/项目", current: "/s/0.jsonl", state, status: "test", theme, height: () => height, done: a => actions.push(a) });
  return { p, state, actions, sessions };
}
test("every view respects terminal dimensions including CJK and tiny widths", () => {
  for (const height of [12, 24, 48]) for (const width of [1, 12, 40, 80, 120]) for (const view of views) {
    const { p, state } = panel(height); state.view = view;
    const lines = p.render(width);
    assert.ok(lines.length <= height, `${view} rows ${lines.length}/${height}`);
    assert.ok(lines.every(l => visibleWidth(l) <= width), `${view} width ${width}`);
  }
});
test("home defaults to sessions, hides UUID filler and offers cwd/files actions", () => {
  const { p, state, actions } = panel();
  assert.equal(state.view, "sessions");
  const output = p.render(120).join("\n");
  assert.match(output, /\[Sessions\]/); assert.doesNotMatch(output, /Recent sessions|User messages · local/);
  p.handleInput("w"); assert.deepEqual(actions.pop(), { kind: "workspaces", cwd: "/work/项目" });
  p.handleInput("a"); assert.deepEqual(actions.pop(), { kind: "artifacts", cwd: "/work/项目" });
});
test("selected cwd filters sessions, search and trash exactly; c clears the selection", () => {
  const { state, sessions } = panel();
  sessions[0]!.cwd = "/other/project";
  state.cwdFilter = "/other/project";
  const p = new HomePanel({ sessions, trash: sessions.slice(0, 2), active: new Set(), state, cwd: "/work/项目", theme, status: "", height: () => 30, done() {} });
  p.render(100); assert.equal(state.selectedPath, sessions[0]!.path);
  assert.match(p.render(100).join("\n"), /1\/1/);
  p.handleInput("/"); p.handleInput("中文"); p.handleInput("\r"); assert.match(p.render(100).join("\n"), /1\/1/);
  p.handleInput("b"); assert.match(p.render(100).join("\n"), /1\/1/);
  p.handleInput("c"); assert.equal(state.cwdFilter, undefined); assert.equal(state.cwdOnly, false);
  assert.match(p.render(100).join("\n"), /1\/2/);
});
test("Enter previews without resuming; Escape preserves selected session", () => {
  const { p, state, actions } = panel(); p.handleInput("s"); p.handleInput("\x1b[B");
  const selected = state.selectedPath; p.handleInput("\r");
  assert.equal(state.preview, selected); assert.deepEqual(actions, []);
  p.render(80); p.handleInput("\x1b"); assert.equal(state.preview, undefined); assert.equal(state.selectedPath, selected);
});
test("delete from preview identifies the selected session and R resumes explicitly", () => {
  const { p, actions, state } = panel(); p.handleInput("s"); p.handleInput("\r");
  p.handleInput("d"); assert.deepEqual(actions[0], { kind: "delete", path: state.preview, id: undefined });
  p.handleInput("R"); assert.equal(actions[1]?.kind, "resume");
});
test("search accepts Chinese; d and q are literal while editing, not destructive shortcuts", () => {
  const { p, state, actions } = panel(); p.focused = true;
  p.handleInput("/"); p.handleInput("中文"); p.handleInput("d"); p.handleInput("q");
  assert.equal(state.query, "中文dq"); assert.equal(actions.length, 0);
  p.handleInput("\r"); assert.ok(p.render(80).join("\n").includes("No matching"));
});
test("all-text search opens details so tool/thinking matches are visible", () => {
  const { p, state } = panel(); p.handleInput("s"); p.handleInput("x"); p.handleInput("/"); p.handleInput("private reasoning"); p.handleInput("\r"); p.handleInput("\r");
  assert.equal(state.showDetails, true); assert.ok(p.render(100).join("\n").includes("private reasoning"));
});
test("list paging can reach all sessions, not just first screen", () => {
  const { p, state, sessions } = panel(); p.handleInput("s"); p.render(80); p.handleInput("G");
  assert.equal(state.selected, sessions.length - 1);
  assert.ok(p.render(80).join("\n").includes("30/30"));
});
test("invalid custom date keeps the editor open with feedback", () => {
  const { p, state } = panel(); p.handleInput("D"); p.handleInput("\x15"); p.handleInput("invalid"); p.handleInput("\r");
  assert.equal(state.range, "today"); assert.match(p.o.status, /Range:/);
});
test("preview huge content can scroll to end and back", () => {
  const { p, state, sessions } = panel(20); sessions[29]!.documents[0]!.text = Array.from({ length: 200 }, (_, i) => `Line ${i}`).join("\n");
  p.handleInput("s"); p.handleInput("\r"); p.render(80); p.handleInput("G");
  assert.ok(state.previewScroll > 100); p.render(80); p.handleInput("g"); assert.equal(state.previewScroll, 0);
});
