import type { MessageDto } from "../../shared/types";
import { dayDiff, formatDaySeparator } from "./format";

export type SendStatus = "sending" | "failed";
export type ClientMessage = MessageDto & { status?: SendStatus };

/** Delivered messages chronologically; the sender's held (quiet-hours) messages go last, like scheduled ones. */
export function sortMessages<T extends MessageDto>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const ha = a.deliverAt !== null ? 1 : 0;
    const hb = b.deliverAt !== null ? 1 : 0;
    if (ha !== hb) return ha - hb;
    if (ha && a.deliverAt !== b.deliverAt) return a.deliverAt! - b.deliverAt!;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id - b.id;
  });
}

export type Row =
  | { kind: "day"; key: string; label: string; held?: boolean }
  | { kind: "unread"; key: string }
  | { kind: "msg"; key: string; message: ClientMessage; first: boolean; last: boolean };

const GROUP_GAP_MS = 5 * 60_000;

/**
 * Turn a sorted message list into rows: day pills, an "unread" divider and
 * grouping flags (consecutive messages from one sender share one tail/avatar).
 */
export function buildRows(
  messages: ClientMessage[],
  opts: { meId: number; unreadAfter?: number | null; now?: number; heldLabel?: string },
): Row[] {
  const now = opts.now ?? Date.now();
  const rows: Row[] = [];
  let prev: ClientMessage | null = null;
  let unreadPlaced = false;
  let heldPlaced = false;

  messages.forEach((m, i) => {
    const held = m.deliverAt !== null;
    if (held && !heldPlaced) {
      rows.push({ kind: "day", key: "held", label: opts.heldLabel ?? "Чекають ранку", held: true });
      heldPlaced = true;
    } else if (!held && (!prev || dayDiff(prev.createdAt, m.createdAt) !== 0)) {
      rows.push({ kind: "day", key: `d${m.createdAt}`, label: formatDaySeparator(m.createdAt, now) });
    }
    if (
      !unreadPlaced &&
      opts.unreadAfter != null &&
      !held &&
      m.senderId !== opts.meId &&
      m.createdAt > opts.unreadAfter &&
      m.id > 0
    ) {
      rows.push({ kind: "unread", key: "unread" });
      unreadPlaced = true;
    }
    const next = messages[i + 1];
    const sameGroup = (a: ClientMessage | null | undefined, b: ClientMessage | null | undefined) =>
      !!a &&
      !!b &&
      a.senderId === b.senderId &&
      (a.deliverAt !== null) === (b.deliverAt !== null) &&
      Math.abs(b.createdAt - a.createdAt) < GROUP_GAP_MS &&
      dayDiff(a.createdAt, b.createdAt) === 0;
    rows.push({
      kind: "msg",
      key: `m${m.id}`,
      message: m,
      first: !sameGroup(prev, m) || rows[rows.length - 1]?.kind !== "msg",
      last: !sameGroup(m, next),
    });
    prev = m;
  });
  return rows;
}

export type TextPart = { type: "text"; value: string } | { type: "link"; value: string; href: string };

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;

/** Split text into plain parts and safe http(s) links. Rendering stays text-only (no HTML injection). */
export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    let url = match[0];
    // Trailing punctuation usually belongs to the sentence, not the URL.
    const trail = /[.,!?:;)\]»…]+$/.exec(url)?.[0] ?? "";
    if (trail) url = url.slice(0, -trail.length);
    const start = match.index;
    if (start > last) parts.push({ type: "text", value: text.slice(last, start) });
    parts.push({ type: "link", value: url, href: url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  return parts;
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*\s*){1,3}$/u;

/** 1–3 emoji without text are shown large, like in Telegram. */
export const isEmojiOnly = (text: string) => EMOJI_ONLY.test(text.trim());
