import type { SqlParam } from "../db";
import { HttpError, notFound, type AppContext } from "../context";
import type { DeliveryMode, MessageDto, MessagesPage, Reaction } from "../../shared/types";
import { quietEndsAt } from "../../shared/quietHours";
import { getUser, quietOf, type UserRow } from "./users";
import { memberIds, privatePeer, requireMember, type ChatRow } from "./chats";

interface MessageRow {
  id: number;
  chat_id: number;
  sender_id: number;
  text: string;
  reply_to_id: number | null;
  buttons: string | null;
  created_at: number;
  edited_at: number | null;
  deliver_at: number | null;
  sender_name: string;
  sender_hue: number;
  r_id: number | null;
  r_text: string | null;
  r_sender_name: string | null;
}

const SELECT_MESSAGE = `
  SELECT m.*, u.display_name AS sender_name, u.avatar_hue AS sender_hue,
         r.id AS r_id, r.text AS r_text, ru.display_name AS r_sender_name
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN messages r ON r.id = m.reply_to_id AND r.deliver_at IS NULL
    LEFT JOIN users ru ON ru.id = r.sender_id`;

export const PAGE_SIZE = 40;

/** Visibility rule: held (quiet-hours) messages exist only for their sender. */
function canSee(row: { sender_id: number; deliver_at: number | null }, viewerId: number) {
  return row.deliver_at === null || row.sender_id === viewerId;
}

async function reactionsFor(ctx: AppContext, ids: number[], viewerId: number): Promise<Map<number, Reaction[]>> {
  const map = new Map<number, Reaction[]>();
  if (ids.length === 0) return map;
  const rows = await ctx.db.all<{ message_id: number; emoji: string; n: number; mine: boolean }>(
    `SELECT message_id, emoji, COUNT(*) AS n, bool_or(user_id = ?) AS mine
       FROM reactions WHERE message_id IN (${ids.map(() => "?").join(",")})
      GROUP BY message_id, emoji ORDER BY MIN(created_at)`,
    viewerId,
    ...ids,
  );
  for (const r of rows) {
    const list = map.get(r.message_id) ?? [];
    list.push({ emoji: r.emoji, count: r.n, mine: !!r.mine });
    map.set(r.message_id, list);
  }
  return map;
}

function toDto(row: MessageRow, viewerId: number, reactions: Reaction[]): MessageDto {
  return {
    id: row.id,
    chatId: row.chat_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderHue: row.sender_hue,
    text: row.text,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deliverAt: row.sender_id === viewerId ? row.deliver_at : null,
    replyTo: row.r_id ? { id: row.r_id, senderName: row.r_sender_name ?? "", text: row.r_text ?? "" } : null,
    reactions,
    buttons: row.buttons ? (JSON.parse(row.buttons) as string[]) : null,
  };
}

async function serializeMany(ctx: AppContext, rows: MessageRow[], viewerId: number): Promise<MessageDto[]> {
  const visible = rows.filter((r) => canSee(r, viewerId));
  const reactions = await reactionsFor(
    ctx,
    visible.map((r) => r.id),
    viewerId,
  );
  return visible.map((r) => toDto(r, viewerId, reactions.get(r.id) ?? []));
}

function loadRow(ctx: AppContext, id: number): Promise<MessageRow | undefined> {
  return ctx.db.one<MessageRow>(`${SELECT_MESSAGE} WHERE m.id = ?`, id);
}

export async function serializeMessage(ctx: AppContext, id: number, viewerId: number): Promise<MessageDto | null> {
  const row = await loadRow(ctx, id);
  if (!row || !canSee(row, viewerId)) return null;
  return (await serializeMany(ctx, [row], viewerId))[0] ?? null;
}

export async function lastVisibleMessage(ctx: AppContext, chatId: number, viewerId: number): Promise<MessageDto | null> {
  const row = await ctx.db.one<MessageRow>(
    `${SELECT_MESSAGE} WHERE m.chat_id = ? AND (m.deliver_at IS NULL OR m.sender_id = ?)
      ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
    chatId,
    viewerId,
  );
  return row ? ((await serializeMany(ctx, [row], viewerId))[0] ?? null) : null;
}

// ---------- Cursor pagination ----------

export function encodeCursor(m: { created_at: number; id: number }) {
  return `${m.created_at}_${m.id}`;
}

export function decodeCursor(cursor: string | undefined | null): { createdAt: number; id: number } | null {
  if (!cursor) return null;
  const m = /^(\d{1,16})_(\d{1,10})$/.exec(cursor);
  if (!m) throw new HttpError(400, "Некоректний курсор");
  return { createdAt: Number(m[1]), id: Number(m[2]) };
}

export async function listMessages(
  ctx: AppContext,
  chatId: number,
  meId: number,
  cursorRaw: string | null,
  limit = PAGE_SIZE,
): Promise<MessagesPage> {
  await requireMember(ctx, chatId, meId);
  const cursor = decodeCursor(cursorRaw);
  const params: SqlParam[] = [chatId];
  let where = "m.chat_id = ? AND m.deliver_at IS NULL";
  if (cursor) {
    where += " AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))";
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const rows = await ctx.db.all<MessageRow>(
    `${SELECT_MESSAGE} WHERE ${where} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
    ...params,
    limit + 1,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  // The sender's own held messages are few; they come with the newest page.
  const held = cursor
    ? []
    : await ctx.db.all<MessageRow>(
        `${SELECT_MESSAGE} WHERE m.chat_id = ? AND m.deliver_at IS NOT NULL AND m.sender_id = ?
          ORDER BY m.deliver_at, m.id`,
        chatId,
        meId,
      );

  return {
    messages: await serializeMany(ctx, [...page.reverse(), ...held], meId),
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  };
}

// ---------- Publishing helpers ----------

async function audience(ctx: AppContext, row: { chat_id: number; sender_id: number; deliver_at: number | null }) {
  return row.deliver_at === null ? memberIds(ctx, row.chat_id) : [row.sender_id];
}

async function publishMessage(ctx: AppContext, id: number, type: "message.new" | "message.updated") {
  const row = await loadRow(ctx, id);
  if (!row) return;
  await ctx.hub.publishEach(await audience(ctx, row), async (uid) => {
    const message = await serializeMessage(ctx, id, uid);
    return message ? { type, message } : null;
  });
}

// ---------- Mutations ----------

export interface SendInput {
  text: string;
  replyToId?: number | null;
  delivery?: DeliveryMode;
  buttons?: string[] | null;
}

/**
 * Decide whether a message must be held because the recipient is in quiet hours.
 * Only for private chats with a human; the sender may override with delivery = "now".
 */
export async function computeDeliverAt(ctx: AppContext, chat: ChatRow, senderId: number, delivery: DeliveryMode) {
  if (chat.type !== "private" || delivery === "now") return null;
  const peer = await privatePeer(ctx, chat.id, senderId);
  if (!peer || peer.id === senderId || peer.is_bot) return null;
  return quietEndsAt(ctx.now(), quietOf(peer));
}

export async function sendMessage(ctx: AppContext, senderId: number, chatId: number, input: SendInput): Promise<MessageDto> {
  const chat = await requireMember(ctx, chatId, senderId);
  const now = ctx.now();

  if (input.replyToId) {
    const target = await ctx.db.one<{ chat_id: number; deliver_at: number | null }>(
      "SELECT chat_id, deliver_at FROM messages WHERE id = ?",
      input.replyToId,
    );
    if (!target || target.chat_id !== chatId || target.deliver_at !== null) {
      throw new HttpError(400, "Не можна відповісти на це повідомлення");
    }
  }

  const deliverAt = await computeDeliverAt(ctx, chat, senderId, input.delivery ?? "gentle");
  const { id } = (await ctx.db.one<{ id: number }>(
    `INSERT INTO messages (chat_id, sender_id, text, reply_to_id, buttons, created_at, deliver_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    chatId,
    senderId,
    input.text,
    input.replyToId ?? null,
    input.buttons?.length ? JSON.stringify(input.buttons) : null,
    now,
    deliverAt,
  ))!;
  // Your own messages never count as unread for you.
  await ctx.db.run(
    "UPDATE chat_members SET last_read_at = GREATEST(last_read_at, ?) WHERE chat_id = ? AND user_id = ?",
    now,
    chatId,
    senderId,
  );

  await publishMessage(ctx, id, "message.new");

  if (deliverAt === null && chat.type === "private") await maybeRunBot(ctx, chat, senderId, input.text);
  if (deliverAt !== null) {
    // Silent counter update for the sleeper ("1 message waits until 08:00") — no content, no sender.
    const recipient = await privatePeer(ctx, chatId, senderId);
    if (recipient) ctx.hub.publish([recipient.id], { type: "me.updated" });
  }
  return (await serializeMessage(ctx, id, senderId))!;
}

async function maybeRunBot(ctx: AppContext, chat: ChatRow, senderId: number, text: string) {
  const bot = await privatePeer(ctx, chat.id, senderId);
  if (!bot || !bot.is_bot || !bot.bot_kind) return;
  // Bots read instantly.
  await ctx.db.run("UPDATE chat_members SET last_read_at = ? WHERE chat_id = ? AND user_id = ?", ctx.now(), chat.id, bot.id);
  ctx.hub.publish([senderId], { type: "chat.read", chatId: chat.id, userId: bot.id, readAt: ctx.now() });
  ctx.hub.publish([senderId], { type: "typing", chatId: chat.id, userId: bot.id, name: bot.display_name });

  ctx.background(
    (async () => {
      const reply = await ctx.bots.reply(bot.bot_kind!, text);
      await sendMessage(ctx, bot.id, chat.id, { text: reply.text, buttons: reply.buttons ?? null, delivery: "now" });
    })(),
  );
}

/** Load a message the user is allowed to act on, or 404 (never reveal other chats' messages). */
async function requireVisible(ctx: AppContext, messageId: number, userId: number) {
  const row = await ctx.db.one<MessageRow & { member: number | null }>(
    `SELECT m.*, cm.user_id AS member FROM messages m
       LEFT JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
      WHERE m.id = ?`,
    userId,
    messageId,
  );
  if (!row || !row.member || !canSee(row, userId)) throw notFound("Повідомлення не знайдено");
  return row;
}

async function requireOwn(ctx: AppContext, messageId: number, userId: number) {
  const row = await requireVisible(ctx, messageId, userId);
  if (row.sender_id !== userId) throw new HttpError(403, "Можна змінювати лише власні повідомлення");
  return row;
}

export async function editMessage(ctx: AppContext, userId: number, messageId: number, text: string): Promise<MessageDto> {
  await requireOwn(ctx, messageId, userId);
  await ctx.db.run("UPDATE messages SET text = ?, edited_at = ? WHERE id = ?", text, ctx.now(), messageId);
  await publishMessage(ctx, messageId, "message.updated");
  return (await serializeMessage(ctx, messageId, userId))!;
}

export async function deleteMessage(ctx: AppContext, userId: number, messageId: number) {
  const row = await requireOwn(ctx, messageId, userId);
  const targets = await audience(ctx, row);
  await ctx.db.run("DELETE FROM messages WHERE id = ?", messageId);
  ctx.hub.publish(targets, { type: "message.deleted", chatId: row.chat_id, messageId });
}

export async function setReaction(ctx: AppContext, userId: number, messageId: number, emoji: string | null): Promise<MessageDto> {
  const row = await requireVisible(ctx, messageId, userId);
  if (row.deliver_at !== null) throw new HttpError(400, "Повідомлення ще не доставлено");
  if (emoji === null) {
    await ctx.db.run("DELETE FROM reactions WHERE message_id = ? AND user_id = ?", messageId, userId);
  } else {
    await ctx.db.run(
      `INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at`,
      messageId,
      userId,
      emoji,
      ctx.now(),
    );
  }
  await publishMessage(ctx, messageId, "message.updated");
  return (await serializeMessage(ctx, messageId, userId))!;
}

export async function markRead(ctx: AppContext, userId: number, chatId: number, upTo: number) {
  await requireMember(ctx, chatId, userId);
  const readAt = Math.min(upTo, ctx.now());
  await ctx.db.run(
    "UPDATE chat_members SET last_read_at = GREATEST(last_read_at, ?) WHERE chat_id = ? AND user_id = ?",
    readAt,
    chatId,
    userId,
  );
  ctx.hub.publish(await memberIds(ctx, chatId), { type: "chat.read", chatId, userId, readAt });
}

export async function sendTyping(ctx: AppContext, user: UserRow, chatId: number) {
  await requireMember(ctx, chatId, user.id);
  const others = (await memberIds(ctx, chatId)).filter((id) => id !== user.id);
  ctx.hub.publish(others, { type: "typing", chatId, userId: user.id, name: user.display_name });
}

// ---------- Quiet-hours delivery ----------

/** Release a held message: it gets the delivery time as its timestamp, like a scheduled message. */
async function deliver(ctx: AppContext, messageId: number) {
  const changed = await ctx.db.run(
    "UPDATE messages SET deliver_at = NULL, created_at = ? WHERE id = ? AND deliver_at IS NOT NULL",
    ctx.now(),
    messageId,
  );
  if (changed === 0) return false;
  const row = (await loadRow(ctx, messageId))!;
  await ctx.hub.publishEach(await memberIds(ctx, row.chat_id), async (uid) => {
    const message = await serializeMessage(ctx, messageId, uid);
    if (!message) return null;
    return uid === row.sender_id ? { type: "message.updated", message } : { type: "message.new", message };
  });
  const recipient = await privatePeer(ctx, row.chat_id, row.sender_id);
  if (recipient) ctx.hub.publish([recipient.id], { type: "me.updated" });
  return true;
}

/** Called by the scheduler: deliver everything whose quiet window has ended. */
export async function deliverDue(ctx: AppContext): Promise<number> {
  const due = await ctx.db.all<{ id: number }>(
    "SELECT id FROM messages WHERE deliver_at IS NOT NULL AND deliver_at <= ? ORDER BY deliver_at, id",
    ctx.now(),
  );
  let n = 0;
  for (const { id } of due) if (await deliver(ctx, id)) n++;
  return n;
}

/** Sender decided it's urgent after all. */
export async function deliverNow(ctx: AppContext, userId: number, messageId: number): Promise<MessageDto> {
  const row = await requireOwn(ctx, messageId, userId);
  if (row.deliver_at === null) throw new HttpError(400, "Повідомлення вже доставлено");
  await deliver(ctx, messageId);
  return (await serializeMessage(ctx, messageId, userId))!;
}

function heldForRecipient(ctx: AppContext, recipientId: number) {
  return ctx.db.all<{ id: number }>(
    `SELECT m.id FROM messages m
       JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
      WHERE m.deliver_at IS NOT NULL AND m.sender_id <> ?
      ORDER BY m.deliver_at, m.id`,
    recipientId,
    recipientId,
  );
}

/** Recipient is awake anyway and wants their messages now. */
export async function releaseHeldFor(ctx: AppContext, recipientId: number): Promise<number> {
  let n = 0;
  for (const { id } of await heldForRecipient(ctx, recipientId)) if (await deliver(ctx, id)) n++;
  return n;
}

/** Recipient changed their quiet hours: move or release messages held for them. */
export async function rescheduleHeldFor(ctx: AppContext, recipientId: number) {
  const user = await getUser(ctx, recipientId);
  if (!user) return;
  const endsAt = quietEndsAt(ctx.now(), quietOf(user));
  if (endsAt === null) {
    await releaseHeldFor(ctx, recipientId);
    return;
  }
  for (const { id } of await heldForRecipient(ctx, recipientId)) {
    await ctx.db.run("UPDATE messages SET deliver_at = ? WHERE id = ?", endsAt, id);
    await publishMessage(ctx, id, "message.updated");
  }
}
