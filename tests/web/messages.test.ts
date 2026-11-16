import { describe, expect, it } from "vitest";
import { buildRows, isEmojiOnly, linkify, sortMessages, type ClientMessage } from "../../src/web/lib/messages";

const base = new Date(2026, 10, 16, 12, 0).getTime();
let nextId = 1;
function msg(partial: Partial<ClientMessage>): ClientMessage {
  return {
    id: nextId++,
    chatId: 1,
    senderId: 1,
    senderName: "A",
    senderHue: 200,
    text: "hi",
    createdAt: base,
    editedAt: null,
    deliverAt: null,
    replyTo: null,
    reactions: [],
    buttons: null,
    ...partial,
  };
}

describe("sortMessages", () => {
  it("orders by time, then id, with held messages last", () => {
    const held = msg({ createdAt: base - 10_000, deliverAt: base + 3600_000 });
    const a = msg({ createdAt: base });
    const b = msg({ createdAt: base - 1000 });
    const c = msg({ createdAt: base });
    expect(sortMessages([held, a, b, c]).map((m) => m.id)).toEqual([b.id, a.id, c.id, held.id]);
  });
});

describe("buildRows", () => {
  it("inserts day pills and groups consecutive messages from one sender", () => {
    const yesterday = msg({ createdAt: base - 24 * 3600_000 });
    const m1 = msg({ createdAt: base });
    const m2 = msg({ createdAt: base + 60_000 });
    const other = msg({ createdAt: base + 120_000, senderId: 2 });
    const rows = buildRows([yesterday, m1, m2, other], { meId: 1, now: base });

    expect(rows.map((r) => (r.kind === "day" ? r.label : r.kind))).toEqual(["Вчора", "msg", "Сьогодні", "msg", "msg", "msg"]);
    const flags = rows.filter((r) => r.kind === "msg").map((r) => (r.kind === "msg" ? [r.first, r.last] : null));
    expect(flags).toEqual([
      [true, true],
      [true, false],
      [false, true],
      [true, true],
    ]);
  });

  it("breaks a group after 5 minutes of silence", () => {
    const rows = buildRows([msg({ createdAt: base }), msg({ createdAt: base + 6 * 60_000 })], { meId: 1, now: base });
    const msgs = rows.filter((r) => r.kind === "msg");
    expect(msgs.every((r) => r.kind === "msg" && r.first && r.last)).toBe(true);
  });

  it("places the unread divider before the first unread incoming message", () => {
    const read = msg({ createdAt: base, senderId: 2 });
    const mine = msg({ createdAt: base + 1000, senderId: 1 });
    const unread = msg({ createdAt: base + 2000, senderId: 2 });
    const rows = buildRows([read, mine, unread], { meId: 1, unreadAfter: base + 500, now: base });
    const idx = rows.findIndex((r) => r.kind === "unread");
    expect(rows[idx + 1]).toMatchObject({ kind: "msg", message: { id: unread.id } });
  });

  it("puts held messages under their own pill", () => {
    const rows = buildRows([msg({}), msg({ deliverAt: base + 1000 })], { meId: 1, now: base, heldLabel: "Чекають" });
    expect(rows.map((r) => r.kind === "day" && r.label).filter(Boolean)).toEqual(["Сьогодні", "Чекають"]);
  });
});

describe("linkify", () => {
  it("extracts http(s) links and keeps trailing punctuation as text", () => {
    expect(linkify("Дивись https://example.com/a?b=1, круто!")).toEqual([
      { type: "text", value: "Дивись " },
      { type: "link", value: "https://example.com/a?b=1", href: "https://example.com/a?b=1" },
      { type: "text", value: ", круто!" },
    ]);
  });

  it("never turns javascript: or other schemes into links", () => {
    expect(linkify("javascript:alert(1) data:text/html,x").every((p) => p.type === "text")).toBe(true);
  });

  it("returns plain text untouched (rendering stays text-only)", () => {
    expect(linkify("<img src=x onerror=alert(1)>")).toEqual([{ type: "text", value: "<img src=x onerror=alert(1)>" }]);
  });
});

describe("isEmojiOnly", () => {
  it("detects 1–3 emoji", () => {
    expect(isEmojiOnly("🔥")).toBe(true);
    expect(isEmojiOnly("👍🏽 ❤️")).toBe(true);
    expect(isEmojiOnly("👨‍👩‍👧")).toBe(true);
    expect(isEmojiOnly("🔥🔥🔥🔥")).toBe(false);
    expect(isEmojiOnly("ok 🔥")).toBe(false);
  });
});
