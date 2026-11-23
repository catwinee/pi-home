// Calendar layout / graded glyphs adapted from pi-stats-ext (MIT), with local-day arithmetic.
import { dayKey, parseDay, shiftDay, type Stats } from "./stats.js";
export interface Palette {
  fg(color: "accent" | "muted" | "dim" | "success" | "error" | "warning" | "text" | "border" | "mdHeading", text: string): string;
  bg(color: "selectedBg", text: string): string;
  bold(text: string): string;
}
export function heatmap(daily: Stats["daily"] | undefined, width: number, theme: Palette, now = Date.now()): string[] {
  const weeks = Math.max(1, Math.min(26, Math.floor((width - 5) / 2)));
  const today = parseDay(dayKey(now))!;
  const start = shiftDay(today, -new Date(today).getDay() - (weeks - 1) * 7);
  const values = daily ? [...daily.values()].map(t => t.users) : [];
  const max = values.reduce((a, b) => Math.max(a, b), 0);
  const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const axis = Array(weeks * 2 - 1).fill(" ");
  // Each column is a Sunday-start week, not an equal-width month. Center labels over
  // their visible Sunday columns; omit tiny edge fragments rather than crowd a neighbor.
  for (let from = 0; from < weeks;) {
    const month = new Date(shiftDay(start, from * 7));
    let to = from + 1;
    while (to < weeks && new Date(shiftDay(start, to * 7)).getMonth() === month.getMonth()) to++;
    const label = month.toLocaleString("en", { month: "short" });
    const span = (to - from) * 2 - 1;
    if (span >= label.length) {
      const column = from * 2 + Math.floor((span - label.length) / 2);
      for (let i = 0; i < label.length; i++) axis[column + i] = label[i];
    }
    from = to;
  }
  const rows = [theme.fg("dim", `    ${axis.join("").trimEnd()}`)];
  for (let day = 0; day < 7; day++) {
    let row = theme.fg("dim", `${labels[day]} `);
    for (let w = 0; w < weeks; w++) {
      const ts = shiftDay(start, w * 7 + day), n = daily?.get(dayKey(ts))?.users || 0;
      // Unknown cells are not zero-activity dots; calendar geometry is available immediately.
      const glyph = daily === undefined ? "—" : n === 0 ? "·" : n / max < .25 ? "░" : n / max < .5 ? "▒" : n / max < .75 ? "▓" : "█";
      row += ts > today ? "  " : `${theme.fg(n ? "success" : "dim", glyph)} `;
    }
    rows.push(row);
  }
  return rows;
}
