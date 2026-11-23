import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { heatmap, type Palette } from "../src/heatmap.js";
import { dayKey, emptyTotals } from "../src/stats.js";

const theme: Palette = { fg: (_, s) => s, bg: (_, s) => s, bold: s => s };
const now = new Date(2026, 9, 16, 12).getTime();

test("month labels center over real week spans instead of crowding the partial edge months", () => {
  const rows = heatmap(new Map(), 110, theme, now);
  assert.equal(rows[0], "    Apr    May      Jun     Jul      Aug      Sep   Oct");
  assert.equal(rows.length, 8, "month axis plus seven weekday rows, no caption or blank footer");
  assert.match(rows.at(-1)!, /^Sat /);
  assert.doesNotMatch(rows.join("\n"), /User messages|User msgs|local dates|last .* weeks/);
  for (const row of rows.slice(1)) assert.equal(visibleWidth(row), 56, "calendar columns have not moved");
});

test("one-week edge months are omitted rather than spilling their labels into neighboring spans", () => {
  const rows = heatmap(new Map(), 110, theme, new Date(2026, 0, 8, 12).getTime());
  assert.equal(rows[0], "     Jul     Aug      Sep     Oct      Nov      Dec");
  assert.doesNotMatch(rows[0]!, /Jan/);
  assert.equal(rows[5]!.slice(-2), "· ", "current Thursday still has its actual calendar cell");
  assert.equal(rows[6]!.slice(-2), "  ", "future Friday is still empty");
});

test("pending and hydrated axes match at narrow widths, year transitions and leap-year dates", () => {
  for (const date of [now, new Date(2026, 0, 8, 12).getTime(), new Date(2024, 2, 10, 12).getTime()]) {
    for (const width of [7, 11, 17, 30, 40, 58, 110]) {
      const pending = heatmap(undefined, width, theme, date), ready = heatmap(new Map(), width, theme, date);
      assert.equal(pending[0], ready[0]);
      assert.equal(pending.length, ready.length);
      assert.ok(pending.every(row => visibleWidth(row) <= width));
      assert.ok(ready.every(row => visibleWidth(row) <= width));
      assert.match(pending[1]!, /—/);
      assert.match(ready[1]!, /·/);
    }
  }
});

test("caption/axis changes do not alter activity values or local-day placement", () => {
  const daily = new Map([[dayKey(now), { ...emptyTotals(), users: 9 }]]);
  const rows = heatmap(daily, 110, theme, now);
  assert.equal(rows[6]!.slice(-2), "█ ", "Friday activity is in the current week column");
  assert.equal((rows.join("").match(/█/g) ?? []).length, 1);
  assert.equal(rows[7]!.slice(-2), "  ");
});
