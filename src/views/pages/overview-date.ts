export function dateKey(value: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).formatToParts(new Date(value));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export interface OverviewEventDayMarker {
  day: string;
  label: string | null;
}

export function overviewEventDayMarker(
  occurredAt: string,
  previousEventDay: string | null,
  today: string,
  timeZone: string,
): OverviewEventDayMarker | null {
  const day = dateKey(occurredAt, timeZone);
  if (day === previousEventDay) {
    return null;
  }
  return { day, label: overviewEventDayLabel(day, today) };
}

export function overviewEventDayLabel(eventDay: string, today: string): string | null {
  if (eventDay === today) {
    return null;
  }
  if (eventDay === shiftDateKey(today, -1)) {
    return "昨天";
  }
  const eventParts = parseDateKey(eventDay);
  const todayParts = parseDateKey(today);
  if (!eventParts || !todayParts) {
    return eventDay;
  }
  const monthDay = `${eventParts.month}月${eventParts.day}日`;
  return eventParts.year === todayParts.year ? monthDay : `${eventParts.year}年${monthDay}`;
}

function shiftDateKey(value: string, days: number): string | null {
  const parts = parseDateKey(value);
  if (!parts) {
    return null;
  }
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  date.setUTCDate(date.getUTCDate() + days);
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function parseDateKey(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}
