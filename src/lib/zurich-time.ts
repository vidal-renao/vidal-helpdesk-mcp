/**
 * Wall-clock formatting for the audit email in Europe/Zurich, always with an
 * explicit CET/CEST suffix so a reader never has to guess the zone.
 *
 * The suffix is derived from the actual UTC offset at that instant (+1h = CET,
 * +2h = CEST) rather than from Intl's `timeZoneName`, whose short names depend
 * on the ICU data bundled with the runtime (small-icu builds print "GMT+1").
 */

export const AUDIT_TIME_ZONE = "Europe/Zurich";

type Parts = { year: number; month: number; day: number; hour: number; minute: number };

function zurichParts(date: Date): Parts {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: AUDIT_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** "CET" or "CEST" for the given instant. */
export function zurichZoneAbbreviation(date: Date): "CET" | "CEST" {
  const p = zurichParts(date);
  const wallClockAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const offsetMinutes = Math.round((wallClockAsUtc - Math.floor(date.getTime() / 60_000) * 60_000) / 60_000);
  return offsetMinutes >= 120 ? "CEST" : "CET";
}

function parse(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date : null;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** "2026-11-14 06:17 CET" */
export function formatZurichDateTime(iso: string): string {
  const date = parse(iso);
  if (!date) return "";
  const p = zurichParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} ${zurichZoneAbbreviation(date)}`;
}

/** "06:17 CET" */
export function formatZurichTime(iso: string): string {
  const date = parse(iso);
  if (!date) return "";
  const p = zurichParts(date);
  return `${pad(p.hour)}:${pad(p.minute)} ${zurichZoneAbbreviation(date)}`;
}

/** "Saturday 14 November 2026" (calendar day in Zurich). */
export function formatZurichLongDate(iso: string): string {
  const date = parse(iso);
  if (!date) return "";
  // Assembled from parts: the separator Intl puts after the weekday differs
  // between ICU versions ("Saturday 14 …" vs "Saturday, 14 …").
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: AUDIT_TIME_ZONE,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")} ${get("year")}`;
}

/** "14 Nov" (calendar day in Zurich). */
export function formatZurichShortDate(iso: string): string {
  const date = parse(iso);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: AUDIT_TIME_ZONE }).format(date);
}
