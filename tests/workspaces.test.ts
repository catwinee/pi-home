import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { InventoryPanel, inventoryState, type InventoryAction } from "../src/workspaces.js";
import type { Inventory } from "../src/inventory.js";
const theme = { fg: (_: unknown, s: string) => s, bg: (_: unknown, s: string) => s, bold: (s: string) => s };
function snapshot(): Inventory {
  return { workspaces: Array.from({ length: 25 }, (_, i) => ({ cwd: `/work/项目-${i}`, sessions: [], bytes: 100 * i, modified: 1, storageDirs: [`/sessions/group-${i}`] })),
    locations: Array.from({ length: 25 }, (_, i) => ({ id: `artifacts:${i}`, path: `/sessions/项目-${i}/subagent-artifacts`, kind: "artifacts" as const,
      cwds: [`/work/项目-${i}`], evidence: "directory association only", notes: ["Not automatically safe to delete"], itemCount: 30,
      files: 30, directories: 1, bytes: 300, modified: 1, symlinks: 0, special: 0, partial: false,
      items: Array.from({ length: 30 }, (_, n) => ({ path: `/artifact/file-${n}`, kind: "file" as const, files: 1, directories: 0, bytes: 10, modified: 1, symlinks: 0, special: 0, partial: false })),
    })), diagnostics: [{ level: "warning", code: "scope-test", path: "/test", message: "synthetic diagnostic" }],
    partial: false, visited: 50, durationMs: 1, scannedAt: 1, limits: { entries: 20000, depth: 6, milliseconds: 5000, items: 100 }, scope: ["Session headers: /sessions"] };
}
function panel(browse = false, height = 24) {
  const state = inventoryState("/work/项目-3", browse), actions: InventoryAction[] = [];
  const p = new InventoryPanel({ state, currentCwd: "/work/项目-3", browse, height: () => height, theme, done: a => actions.push(a) });
  p.setInventory(snapshot());
  return { p, state, actions };
}
test("workspace picker selects exact cwd, supports Chinese filtering and does not change working directory", () => {
  const { p, actions } = panel(true); p.focused = true;
  p.handleInput("/"); p.handleInput("项目-22"); p.handleInput("\r"); p.handleInput("\r");
  assert.deepEqual(actions, [{ kind: "sessions", cwd: "/work/项目-22" }]);
  assert.equal(p.o.currentCwd, "/work/项目-3");
});
test("artifacts inventory is read-only, shows selected-location distribution, and returns to the same list position", () => {
  const { p, state, actions } = panel();
  p.handleInput("a"); p.handleInput("j"); p.render(100); const id = state.locationId;
  p.handleInput("\r"); assert.equal(state.view, "detail");
  assert.match(p.render(100).join("\n"), /directory association only/);
  for (const key of ["d", "\x04", "u", "R"]) p.handleInput(key);
  assert.deepEqual(actions, []);
  p.handleInput("G"); assert.match(p.render(100).join("\n"), /file-29/);
  p.handleInput("\x1b"); assert.equal(state.view, "locations"); assert.equal(state.locationId, id);
});
test("all inventory views, loading, errors and diagnostics stay bounded at tiny/CJK widths", () => {
  for (const width of [1, 12, 40, 80]) for (const height of [8, 24, 40]) {
    const { p, state } = panel(false, height);
    for (const view of ["workspaces", "locations", "detail", "diagnostics"] as const) {
      state.view = view; const rows = p.render(width);
      assert.ok(rows.length <= height); assert.ok(rows.every(l => visibleWidth(l) <= width));
    }
    p.inventory = undefined; assert.ok(p.render(width).every(l => visibleWidth(l) <= width));
    p.error = "synthetic error"; assert.ok(p.render(width).length <= height);
  }
});
test("refresh preserves cwd/location identity when snapshot order changes; diagnostics stay in the panel", () => {
  const { p, state, actions } = panel();
  const oldId = state.locationId; p.handleInput("r"); assert.deepEqual(actions, [{ kind: "refresh" }]);
  const newer = snapshot(); newer.locations.reverse(); p.setInventory(newer); assert.equal(state.locationId, oldId);
  p.handleInput("i"); const text = p.render(140).join("\n");
  assert.match(text, /synthetic diagnostic/); assert.match(text, /NOT inventoried/);
  p.handleInput("\x1b"); assert.equal(state.view, "locations"); assert.equal(state.locationId, oldId);
});
test("closing a loading inventory is possible before any scan result exists", () => {
  const { p, actions } = panel(); p.inventory = undefined; p.handleInput("\x1b");
  assert.deepEqual(actions, [{ kind: "close" }]);
});
