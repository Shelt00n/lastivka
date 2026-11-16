/** Date/time and Ukrainian plural helpers. Pure functions — unit-tested. */

const MONTHS_GEN = [
  "січня", "лютого", "березня", "квітня", "травня", "червня",
  "липня", "серпня", "вересня", "жовтня", "листопада", "грудня",
];
const MONTHS_SHORT = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
const WEEKDAYS_SHORT = ["Нд", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

const pad = (n: number) => String(n).padStart(2, "0");

export function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Calendar days between two instants in local time (DST-safe). */
export function dayDiff(ts: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
}

/** Chat list: "14:05" today, "Пн" this week, "12 бер" this year, "12.03.25" older. */
export function formatChatDate(ts: number, now = Date.now()): string {
  const diff = dayDiff(ts, now);
  const d = new Date(ts);
  if (diff <= 0) return formatTime(ts);
  if (diff < 7) return WEEKDAYS_SHORT[d.getDay()]!;
  if (d.getFullYear() === new Date(now).getFullYear()) return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
}

/** Future moment relative to now: "о 08:00", "завтра о 00:30", "18.11 о 08:00". */
export function formatWhen(ts: number, now = Date.now()): string {
  const diff = dayDiff(now, ts);
  if (diff <= 0) return `о ${formatTime(ts)}`;
  if (diff === 1) return `завтра о ${formatTime(ts)}`;
  const d = new Date(ts);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} о ${formatTime(ts)}`;
}

/** Floating date pill in a chat. */
export function formatDaySeparator(ts: number, now = Date.now()): string {
  const diff = dayDiff(ts, now);
  if (diff === 0) return "Сьогодні";
  if (diff === 1) return "Вчора";
  const d = new Date(ts);
  const base = `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** Telegram-like presence line, gender-neutral. */
export function formatLastSeen(online: boolean, lastSeenAt: number | null, now = Date.now()): string {
  if (online) return "в мережі";
  if (!lastSeenAt) return "був(ла) давно";
  const minutes = Math.floor((now - lastSeenAt) / 60_000);
  if (minutes < 1) return "був(ла) щойно";
  if (minutes < 60) return `був(ла) ${minutes} хв тому`;
  const diff = dayDiff(lastSeenAt, now);
  if (diff === 0) return `був(ла) о ${formatTime(lastSeenAt)}`;
  if (diff === 1) return `був(ла) вчора о ${formatTime(lastSeenAt)}`;
  const d = new Date(lastSeenAt);
  return `був(ла) ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
}

/** Ukrainian plural: pluralUk(5, ["учасник", "учасники", "учасників"]) → "учасників". */
export function pluralUk(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

export const formatMembers = (n: number) => `${n} ${pluralUk(n, ["учасник", "учасники", "учасників"])}`;

export function initials(name: string): string {
  // Only letters/digits count: «Команда «Ластівки»» → "КЛ", not "К«".
  const words = name.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  const letters = words.slice(0, 2).map((w) => Array.from(w)[0] ?? "");
  return letters.join("").toUpperCase() || "?";
}

/** "Chrome · macOS" from a user-agent string, for the active sessions list. */
export function describeUserAgent(ua: string): string {
  if (!ua) return "Невідомий пристрій";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Браузер";
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} · ${os}` : browser;
}
