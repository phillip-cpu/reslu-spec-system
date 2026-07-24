const ADELAIDE = "Australia/Adelaide";

function adelaideDateParts(date: Date): { y: number; m: number; d: number; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ADELAIDE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return { y: Number(value("year")), m: Number(value("month")), d: Number(value("day")), weekday: value("weekday") };
}

/** Mon-Fri resolves to that week's Friday; Sat/Sun resolves to the Friday just passed. */
export function currentAdelaideWeekEnding(date = new Date()): string {
  const local = adelaideDateParts(date);
  const dayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(local.weekday);
  const delta = dayIndex === 0 ? -2 : 5 - dayIndex;
  const utc = new Date(Date.UTC(local.y, local.m - 1, local.d + delta));
  return utc.toISOString().slice(0, 10);
}

export function normalizeActionItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((item) => item.slice(0, 300));
}

export function actionItemsFromText(value: string): string[] {
  return normalizeActionItems(value.split(/\r?\n/));
}
