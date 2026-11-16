import { HttpError, notFound, withDb, type AppContext } from "../context";
import type { ChatDetail, ChatSummary } from "../../shared/types";
import { getUser, toPublicUser, type UserRow } from "./users";
import { lastVisibleMessage } from "./messages";
import { hueFor } from "../security";

export interface ChatRow {
  id: number;
  type: "private" | "group";
  title: string | null;
  private_key: string | null;
  avatar_hue: number;
  created_by: number | null;
  created_at: number;
}

interface MemberRow extends ChatRow {
  last_read_at: number;
  pinned: number;
  muted: number;
}

export const SAVED_TITLE = "Збережене";

/**
 * The single authorization gate for everything chat-related.
 * Non-members get 404 (not 403) so chat ids can't be probed.
 */
export async function requireMember(ctx: AppContext, chatId: number, userId: number): Promise<ChatRow> {
  const chat = await ctx.db.one<ChatRow>(
    `SELECT c.* FROM chats c JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = ? WHERE c.id = ?`,
    userId,
    chatId,
  );
  if (!chat) throw notFound("Чат не знайдено");
  return chat;
}

export async function memberIds(ctx: AppContext, chatId: number): Promise<number[]> {
  const rows = await ctx.db.all<{ user_id: number }>("SELECT user_id FROM chat_members WHERE chat_id = ?", chatId);
  return rows.map((r) => r.user_id);
}

/** The other person in a private chat; yourself for "Saved Messages". */
export async function privatePeer(ctx: AppContext, chatId: number, meId: number): Promise<UserRow | undefined> {
  const other = await ctx.db.one<UserRow>(
    `SELECT u.* FROM chat_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.chat_id = ? AND cm.user_id <> ? LIMIT 1`,
    chatId,
    meId,
  );
  return other ?? getUser(ctx, meId);
}

const privateKey = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;

async function summarize(ctx: AppContext, chat: MemberRow, meId: number): Promise<ChatSummary> {
  const isSaved = chat.private_key === privateKey(meId, meId);
  const peerRow = chat.type === "private" ? await privatePeer(ctx, chat.id, meId) : undefined;
  const peer = peerRow ? toPublicUser(ctx, peerRow) : null;

  const [unread, others, lastMessage] = await Promise.all([
    ctx.db.one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM messages
        WHERE chat_id = ? AND sender_id <> ? AND deliver_at IS NULL AND created_at > ?`,
      chat.id,
      meId,
      chat.last_read_at,
    ),
    ctx.db.one<{ n: number; read_at: number | null }>(
      "SELECT COUNT(*) AS n, MAX(last_read_at) AS read_at FROM chat_members WHERE chat_id = ? AND user_id <> ?",
      chat.id,
      meId,
    ),
    lastVisibleMessage(ctx, chat.id, meId),
  ]);

  return {
    id: chat.id,
    type: chat.type,
    title: isSaved ? SAVED_TITLE : chat.type === "group" ? (chat.title ?? "Група") : (peer?.displayName ?? "Видалений акаунт"),
    peer,
    isSaved,
    avatarHue: chat.type === "group" ? chat.avatar_hue : (peer?.avatarHue ?? 210),
    memberCount: (others?.n ?? 0) + 1,
    lastMessage,
    unreadCount: unread?.n ?? 0,
    pinned: !!chat.pinned,
    muted: !!chat.muted,
    // In Saved Messages everything is "read" by definition.
    peerReadAt: isSaved ? Number.MAX_SAFE_INTEGER : (others?.read_at ?? 0),
    myReadAt: chat.last_read_at,
  };
}

export async function listChats(ctx: AppContext, meId: number): Promise<ChatSummary[]> {
  const rows = await ctx.db.all<MemberRow>(
    `SELECT c.*, cm.last_read_at, cm.pinned, cm.muted
       FROM chats c JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = ?`,
    meId,
  );
  const items = await Promise.all(rows.map(async (row) => ({ row, chat: await summarize(ctx, row, meId) })));
  return (
    items
      // A private chat someone opened with me but never wrote in stays hidden for me.
      .filter(({ row, chat }) => chat.lastMessage || chat.isSaved || chat.type === "group" || row.created_by === meId)
      .map(({ row, chat }) => ({ chat, activity: chat.lastMessage?.createdAt ?? row.created_at }))
      .sort((a, b) => {
        if (a.chat.pinned !== b.chat.pinned) return a.chat.pinned ? -1 : 1;
        return b.activity - a.activity;
      })
      .map(({ chat }) => chat)
  );
}

export async function getChat(ctx: AppContext, chatId: number, meId: number): Promise<ChatDetail> {
  await requireMember(ctx, chatId, meId);
  const row = (await ctx.db.one<MemberRow>(
    `SELECT c.*, cm.last_read_at, cm.pinned, cm.muted
       FROM chats c JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = ? WHERE c.id = ?`,
    meId,
    chatId,
  ))!;
  const members = await ctx.db.all<UserRow>(
    `SELECT u.* FROM chat_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.chat_id = ? ORDER BY cm.role = 'owner' DESC, lower(u.display_name)`,
    chatId,
  );
  return { ...(await summarize(ctx, row, meId)), members: members.map((u) => toPublicUser(ctx, u)) };
}

export async function openPrivateChat(ctx: AppContext, meId: number, otherId: number): Promise<number> {
  const other = await getUser(ctx, otherId);
  if (!other) throw notFound("Користувача не знайдено");
  const key = privateKey(meId, otherId);
  const existing = await ctx.db.one<{ id: number }>("SELECT id FROM chats WHERE private_key = ?", key);
  if (existing) return existing.id;

  const now = ctx.now();
  return ctx.db.tx(async (db) => {
    // ON CONFLICT: two tabs opening the same chat at once must not create two chats.
    const created = await db.one<{ id: number }>(
      `INSERT INTO chats (type, private_key, created_by, created_at) VALUES ('private', ?, ?, ?)
       ON CONFLICT (private_key) DO NOTHING RETURNING id`,
      key,
      meId,
      now,
    );
    if (!created) return (await db.one<{ id: number }>("SELECT id FROM chats WHERE private_key = ?", key))!.id;
    for (const uid of new Set([meId, otherId])) {
      await db.run("INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)", created.id, uid, now);
    }
    return created.id;
  });
}

export async function createGroup(ctx: AppContext, meId: number, title: string, memberIdsInput: number[]): Promise<number> {
  const ids = [...new Set(memberIdsInput.filter((id) => id !== meId))];
  if (ids.length === 0) throw new HttpError(400, "Додайте хоча б одного учасника");
  const found = await ctx.db.all<{ id: number }>(
    `SELECT id FROM users WHERE is_bot = 0 AND id IN (${ids.map(() => "?").join(",")})`,
    ...ids,
  );
  if (found.length !== ids.length) throw new HttpError(400, "Деяких учасників не знайдено");

  const now = ctx.now();
  const chatId = await ctx.db.tx(async (db) => {
    const t = withDb(ctx, db);
    const { id } = (await t.db.one<{ id: number }>(
      "INSERT INTO chats (type, title, avatar_hue, created_by, created_at) VALUES ('group', ?, ?, ?, ?) RETURNING id",
      title,
      hueFor(title + now),
      meId,
      now,
    ))!;
    await t.db.run("INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)", id, meId, now);
    for (const uid of ids) {
      await t.db.run("INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)", id, uid, now);
    }
    return id;
  });
  ctx.hub.publish([meId, ...ids], { type: "chat.new", chatId });
  return chatId;
}

export async function updateChatSettings(
  ctx: AppContext,
  meId: number,
  chatId: number,
  patch: { pinned?: boolean; muted?: boolean },
) {
  await requireMember(ctx, chatId, meId);
  if (patch.pinned !== undefined) {
    await ctx.db.run("UPDATE chat_members SET pinned = ? WHERE chat_id = ? AND user_id = ?", +patch.pinned, chatId, meId);
  }
  if (patch.muted !== undefined) {
    await ctx.db.run("UPDATE chat_members SET muted = ? WHERE chat_id = ? AND user_id = ?", +patch.muted, chatId, meId);
  }
}
