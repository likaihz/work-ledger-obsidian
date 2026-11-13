import type { DateFilter } from "./spec";

export type DateContext = { kind: "ready"; today: string; timezone: string } | { kind: "unavailable"; timezone: string };

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= ([31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0);
}
// UTC is used only as an integer calendar arithmetic domain, never the business timezone.
export function addDays(date: string, count: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + count);
  return day.toISOString().slice(0, 10);
}
export function dateContext(timezone: string, now = new Date()): DateContext {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const part = (type: string) => parts.find((item) => item.type === type)?.value;
    const today = `${part("year")}-${part("month")}-${part("day")}`;
    return isCalendarDate(today) ? { kind: "ready", today, timezone } : { kind: "unavailable", timezone };
  } catch { return { kind: "unavailable", timezone }; }
}
export function weekStart(today: string): string {
  return addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
}
export function isRelative(filter: DateFilter): boolean { return !["any", "set", "unset", "range"].includes(filter.mode); }
export function dateRange(filter: DateFilter, today: string): { from: string | null; to: string | null } {
  switch (filter.mode) {
    case "range": return filter;
    case "beforeToday": return { from: null, to: addDays(today, -1) };
    case "today": return { from: today, to: today };
    case "thisWeek": return { from: weekStart(today), to: addDays(weekStart(today), 6) };
    case "nextWeek": return { from: addDays(weekStart(today), 7), to: addDays(weekStart(today), 13) };
    case "next7Days": return { from: today, to: addDays(today, 6) };
    default: return { from: null, to: null };
  }
}
export function matchesDate(value: string | null, filter: DateFilter, context: DateContext): boolean {
  if (filter.mode === "any") return true;
  if (filter.mode === "unset") return value === null;
  if (value === null) return false;
  if (filter.mode === "set") return true;
  const range = dateRange(filter, context.kind === "ready" ? context.today : "");
  return (!range.from || value >= range.from) && (!range.to || value <= range.to);
}
export const DATE_BUCKETS = ["过去", "今天", "明天", "本周其余", "下周", "更晚", "未设置"];
export function dateBucket(value: string | null, today: string): string {
  if (value === null) return "未设置";
  if (value < today) return "过去";
  if (value === today) return "今天";
  if (value === addDays(today, 1)) return "明天";
  const end = addDays(weekStart(today), 6);
  if (value <= end) return "本周其余";
  if (value <= addDays(end, 7)) return "下周";
  return "更晚";
}
