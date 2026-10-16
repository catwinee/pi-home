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
  const axis = Array(weeks * 2).fill(" ");
  let lastMonth = -1, lastEnd = -1;
  for (let w = 0; w < weeks; w++) {
    const d = new Date(shiftDay(start, w * 7));
    if (d.getMonth() === lastMonth) continue;
    lastMonth = d.getMonth();
    const label = d.toLocaleString("en", { month: "short" });
    if (w * 2 > lastEnd && w * 2 + label.length <= axis.length) {
      for (let i = 0; i < label.length; i++) axis[w * 2 + i] = label[i];
      lastEnd = w * 2 + label.length;
    }
  }
  const rows = [theme.fg("dim", `    ${axis.join("")}`)];
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
  rows.push(theme.fg("muted", width < 44 ? `User msgs · local · ${weeks}w` : `User messages · local dates · last ${weeks} weeks`));
  return rows;
}
