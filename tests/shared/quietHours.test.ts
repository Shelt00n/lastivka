import { describe, expect, it } from "vitest";
import {
  formatClock,
  hhmmToMinutes,
  isInWindow,
  isQuietNow,
  isValidTimeZone,
  minutesToHHMM,
  quietEndsAt,
  timeZoneOffsetMs,
  zonedWallTimeToUtc,
  type QuietSettings,
} from "../../src/shared/quietHours";

const H = 60;
const kyivNight: QuietSettings = { enabled: true, start: 23 * H, end: 8 * H, timeZone: "Europe/Kyiv" };
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

describe("isInWindow", () => {
  it("handles a same-day window with inclusive start and exclusive end", () => {
    expect(isInWindow(13 * H, 13 * H, 15 * H)).toBe(true);
    expect(isInWindow(14 * H + 59, 13 * H, 15 * H)).toBe(true);
    expect(isInWindow(15 * H, 13 * H, 15 * H)).toBe(false);
    expect(isInWindow(12 * H + 59, 13 * H, 15 * H)).toBe(false);
  });

  it("handles a window that wraps past midnight", () => {
    expect(isInWindow(23 * H, 23 * H, 8 * H)).toBe(true);
    expect(isInWindow(0, 23 * H, 8 * H)).toBe(true);
    expect(isInWindow(7 * H + 59, 23 * H, 8 * H)).toBe(true);
    expect(isInWindow(8 * H, 23 * H, 8 * H)).toBe(false);
    expect(isInWindow(12 * H, 23 * H, 8 * H)).toBe(false);
  });

  it("treats start === end as an empty window", () => {
    expect(isInWindow(10 * H, 10 * H, 10 * H)).toBe(false);
  });
});

describe("quietEndsAt", () => {
  it("returns the end of the window later the same night (after midnight)", () => {
    // 22:30Z = 00:30 in Kyiv (UTC+2 in November) → ends 08:00 Kyiv = 06:00Z
    const now = Date.UTC(2026, 10, 16, 22, 30);
    expect(isQuietNow(now, kyivNight)).toBe(true);
    expect(iso(quietEndsAt(now, kyivNight))).toBe("2026-11-17T06:00:00.000Z");
  });

  it("returns tomorrow's end when the window just started (before midnight)", () => {
    const now = Date.UTC(2026, 10, 16, 21, 30); // 23:30 Kyiv
    expect(iso(quietEndsAt(now, kyivNight))).toBe("2026-11-17T06:00:00.000Z");
  });

  it("returns null outside the window and when disabled", () => {
    const noon = Date.UTC(2026, 10, 16, 10, 0);
    expect(quietEndsAt(noon, kyivNight)).toBeNull();
    expect(quietEndsAt(Date.UTC(2026, 10, 16, 22, 30), { ...kyivNight, enabled: false })).toBeNull();
  });

  it("uses the recipient's timezone, not the server's", () => {
    const now = Date.UTC(2026, 10, 16, 15, 0); // 17:00 Kyiv, 00:00 Tokyo, 10:00 New York
    const tokyo = { ...kyivNight, timeZone: "Asia/Tokyo" };
    const newYork = { ...kyivNight, timeZone: "America/New_York" };
    expect(isQuietNow(now, kyivNight)).toBe(false);
    expect(isQuietNow(now, newYork)).toBe(false);
    expect(iso(quietEndsAt(now, tokyo))).toBe("2026-11-16T23:00:00.000Z"); // 08:00 JST
  });

  it("survives spring-forward DST (night is one hour shorter)", () => {
    // Kyiv switches 03:00 EET → 04:00 EEST on 2026-03-29.
    const now = Date.UTC(2026, 2, 28, 21, 30); // 23:30 EET
    expect(iso(quietEndsAt(now, kyivNight))).toBe("2026-03-29T05:00:00.000Z"); // 08:00 EEST
  });

  it("survives fall-back DST (night is one hour longer)", () => {
    // Kyiv switches 04:00 EEST → 03:00 EET on 2026-10-25.
    const now = Date.UTC(2026, 9, 24, 20, 30); // 23:30 EEST
    expect(iso(quietEndsAt(now, kyivNight))).toBe("2026-10-25T06:00:00.000Z"); // 08:00 EET
  });

  it("moves an end time that falls into the DST gap forward", () => {
    const s = { ...kyivNight, start: 1 * H, end: 3 * H + 30 }; // 03:30 does not exist on 2026-03-29
    const now = Date.UTC(2026, 2, 28, 23, 30); // 01:30 EET
    expect(iso(quietEndsAt(now, s))).toBe("2026-03-29T01:30:00.000Z"); // 04:30 EEST
  });

  it("handles US DST dates that differ from Europe", () => {
    // New York springs forward on 2026-03-08; at 23:30 EST on the 7th the end is 08:00 EDT = 12:00Z.
    const ny = { ...kyivNight, timeZone: "America/New_York" };
    expect(iso(quietEndsAt(Date.UTC(2026, 2, 8, 4, 30), ny))).toBe("2026-03-08T12:00:00.000Z");
  });
});

describe("timezone helpers", () => {
  it("computes offsets including DST", () => {
    expect(timeZoneOffsetMs(Date.UTC(2026, 0, 15), "Europe/Kyiv")).toBe(2 * 3600_000);
    expect(timeZoneOffsetMs(Date.UTC(2026, 6, 15), "Europe/Kyiv")).toBe(3 * 3600_000);
    expect(timeZoneOffsetMs(Date.UTC(2026, 6, 15), "America/New_York")).toBe(-4 * 3600_000);
  });

  it("converts wall time to UTC", () => {
    expect(iso(zonedWallTimeToUtc(2026, 7, 1, 9, 15, "Europe/Kyiv"))).toBe("2026-07-01T06:15:00.000Z");
    expect(iso(zonedWallTimeToUtc(2026, 1, 1, 0, 0, "Asia/Tokyo"))).toBe("2025-12-31T15:00:00.000Z");
  });

  it("formats and parses HH:MM", () => {
    expect(minutesToHHMM(0)).toBe("00:00");
    expect(minutesToHHMM(8 * H + 5)).toBe("08:05");
    expect(minutesToHHMM(-30)).toBe("23:30");
    expect(hhmmToMinutes("23:30")).toBe(23 * H + 30);
    expect(hhmmToMinutes("7:05")).toBe(7 * H + 5);
    expect(hhmmToMinutes("24:00")).toBeNull();
    expect(hhmmToMinutes("abc")).toBeNull();
    expect(formatClock(Date.UTC(2026, 10, 16, 22, 30), "Europe/Kyiv")).toBe("00:30");
  });

  it("validates IANA timezones", () => {
    expect(isValidTimeZone("Europe/Kyiv")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});
