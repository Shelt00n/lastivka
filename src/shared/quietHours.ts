/**
 * Quiet hours ("Тихі години") — the new feature.
 *
 * A user picks a daily window in *their own* timezone (e.g. 23:00–08:00).
 * Messages sent to them inside that window are held on the server and
 * delivered when the window ends. All maths is done with the Intl API so
 * DST transitions and windows that cross midnight are handled correctly.
 *
 * Shared by server (scheduling) and client (banner / preview), so both
 * always agree on the delivery time.
 */

export interface QuietSettings {
  enabled: boolean;
  /** Minutes since local midnight, 0..1439 */
  start: number;
  end: number;
  timeZone: string;
}

export const MINUTES_IN_DAY = 24 * 60;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== "string" || timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock components of an instant in the given IANA timezone. */
export function zonedParts(instant: number, timeZone: string): ZonedParts {
  const out: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(instant))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year!,
    month: out.month!,
    day: out.day!,
    hour: out.hour! % 24,
    minute: out.minute!,
    second: out.second!,
  };
}

/** Offset of the timezone from UTC at the given instant, in ms (Kyiv summer → +3h). */
export function timeZoneOffsetMs(instant: number, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * Convert a wall-clock time in a timezone to a UTC instant.
 * If the wall time falls into a DST gap (does not exist), the result is
 * shifted forward by the gap (03:30 on spring-forward day → 04:30).
 */
export function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset1 = timeZoneOffsetMs(guess, timeZone);
  const candidate = guess - offset1;
  const offset2 = timeZoneOffsetMs(candidate, timeZone);
  if (offset1 === offset2) return candidate;
  return guess - offset2;
}

export function localMinutes(instant: number, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  return p.hour * 60 + p.minute;
}

/** Is `minute` inside [start, end)? Supports windows that wrap past midnight. start === end means "empty". */
export function isInWindow(minute: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

export function isQuietNow(now: number, s: QuietSettings): boolean {
  if (!s.enabled) return false;
  return isInWindow(localMinutes(now, s.timeZone), s.start, s.end);
}

/** UTC instant when the current quiet window ends, or null if not in quiet hours. */
export function quietEndsAt(now: number, s: QuietSettings): number | null {
  if (!isQuietNow(now, s)) return null;
  const p = zonedParts(now, s.timeZone);
  const minute = p.hour * 60 + p.minute;
  // The end is later today if we're before it (after-midnight part), otherwise tomorrow.
  const dayShift = minute < s.end ? 0 : 1;
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + dayShift));
  return zonedWallTimeToUtc(
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    Math.floor(s.end / 60),
    s.end % 60,
    s.timeZone,
  );
}

/** "08:00" for 480 */
export function minutesToHHMM(minutes: number): string {
  const m = ((minutes % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** 480 for "08:00"; null for invalid input */
export function hhmmToMinutes(value: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Wall-clock "HH:MM" of an instant in a timezone. */
export function formatClock(instant: number, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return minutesToHHMM(p.hour * 60 + p.minute);
}
