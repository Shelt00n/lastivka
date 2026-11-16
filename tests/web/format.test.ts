import { describe, expect, it } from "vitest";
import {
  describeUserAgent,
  formatChatDate,
  formatDaySeparator,
  formatLastSeen,
  formatWhen,
  initials,
  pluralUk,
} from "../../src/web/lib/format";

// vitest.config sets TZ=Europe/Kyiv; build dates as local wall time.
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 11, 16, 15, 0); // Monday

describe("Ukrainian plurals", () => {
  it.each([
    [1, "учасник"],
    [2, "учасники"],
    [4, "учасники"],
    [5, "учасників"],
    [11, "учасників"],
    [12, "учасників"],
    [21, "учасник"],
    [22, "учасники"],
    [111, "учасників"],
  ])("%i → %s", (n, word) => {
    expect(pluralUk(n, ["учасник", "учасники", "учасників"])).toBe(word);
  });
});

describe("chat list dates", () => {
  it("shows time today, weekday this week, date otherwise", () => {
    expect(formatChatDate(at(2026, 11, 16, 9, 5), NOW)).toBe("09:05");
    expect(formatChatDate(at(2026, 11, 14), NOW)).toBe("Сб");
    expect(formatChatDate(at(2026, 10, 3), NOW)).toBe("3 жов");
    expect(formatChatDate(at(2025, 3, 12), NOW)).toBe("12.03.25");
  });

  it("labels day separators", () => {
    expect(formatDaySeparator(at(2026, 11, 16, 1), NOW)).toBe("Сьогодні");
    expect(formatDaySeparator(at(2026, 11, 15, 23, 59), NOW)).toBe("Вчора");
    expect(formatDaySeparator(at(2026, 3, 8), NOW)).toBe("8 березня");
    expect(formatDaySeparator(at(2025, 12, 31), NOW)).toBe("31 грудня 2025");
  });

  it("describes future delivery times", () => {
    expect(formatWhen(at(2026, 11, 16, 23, 0), NOW)).toBe("о 23:00");
    expect(formatWhen(at(2026, 11, 17, 8, 0), NOW)).toBe("завтра о 08:00");
    expect(formatWhen(at(2026, 11, 19, 8, 0), NOW)).toBe("19.11 о 08:00");
  });
});

describe("last seen", () => {
  it("covers the Telegram-style ranges", () => {
    expect(formatLastSeen(true, null, NOW)).toBe("в мережі");
    expect(formatLastSeen(false, NOW - 20_000, NOW)).toBe("був(ла) щойно");
    expect(formatLastSeen(false, NOW - 5 * 60_000, NOW)).toBe("був(ла) 5 хв тому");
    expect(formatLastSeen(false, at(2026, 11, 16, 9, 30), NOW)).toBe("був(ла) о 09:30");
    expect(formatLastSeen(false, at(2026, 11, 15, 22, 10), NOW)).toBe("був(ла) вчора о 22:10");
    expect(formatLastSeen(false, at(2026, 11, 1), NOW)).toBe("був(ла) 01.11.26");
    expect(formatLastSeen(false, null, NOW)).toBe("був(ла) давно");
  });
});

describe("misc", () => {
  it("builds avatar initials from letters only", () => {
    expect(initials("Олена Бондар")).toBe("ОБ");
    expect(initials("Команда «Ластівки»")).toBe("КЛ");
    expect(initials("kenji")).toBe("K");
    expect(initials("  ")).toBe("?");
  });

  it("describes devices for the sessions list", () => {
    expect(
      describeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1"),
    ).toBe("Safari · iOS");
    expect(
      describeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0"),
    ).toBe("Edge · Windows");
    expect(describeUserAgent("")).toBe("Невідомий пристрій");
  });
});
