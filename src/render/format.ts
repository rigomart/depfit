/** Value formatters for the human table. Pure; no verdicts, just units. */

export const NONE = "-";

const DAY_MS = 86_400_000;

function trimZero(text: string): string {
  return text.replace(/\.0$/, "");
}

/** SI units: 92557 → "92.6 KB", 29435001 → "29.4 MB". */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const text = unit === 0 ? String(value) : value.toFixed(1);
  return `${text} ${units[unit]}`;
}

/** 334432403 → "334M", 22193314 → "22.2M", 950 → "950". */
export function formatCompact(n: number | null): string {
  if (n === null) return NONE;
  const steps: Array<[number, string]> = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of steps) {
    if (Math.abs(n) >= size) {
      const value = n / size;
      return `${value >= 100 ? Math.round(value) : trimZero(value.toFixed(1))}${suffix}`;
    }
  }
  return String(n);
}

export function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** Time from `iso` to `now`: "today", "27 days ago", "384 days ago", "6 years ago". */
export function formatAgo(iso: string | null, now: string): string {
  if (iso === null) return NONE;
  const then = Date.parse(iso);
  const ref = Date.parse(now);
  if (Number.isNaN(then) || Number.isNaN(ref)) return iso;
  return formatDaysAgo(Math.floor((ref - then) / DAY_MS));
}

/**
 * 0 → "today", 384 → "384 days ago", 2400 → "6 years ago".
 * Exact days up to two years: rounding 384 to "12 months" hides that a year has passed.
 */
export function formatDaysAgo(days: number): string {
  if (days < 1) return "today";
  if (days < 730) return `${plural(days, "day")} ago`;
  return `${plural(Math.floor(days / 365.25), "year")} ago`;
}

export function formatBool(value: boolean | null): string {
  if (value === null) return NONE;
  return value ? "yes" : "no";
}

export function formatCount(n: number | null): string {
  return n === null ? NONE : String(n);
}

/** First `max` items, then "+N more". Returns one entry per output line. */
export function headOfList(items: string[], max = 2): string[] {
  if (items.length <= max) return items;
  return [...items.slice(0, max), `+${items.length - max} more`];
}

/** Same as headOfList, joined on one line: "3.23.8, 4.6.5, +1 more". */
export function inlineList(items: string[], max = 2): string {
  return headOfList(items, max).join(", ");
}
