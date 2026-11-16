import type { AppContext } from "../context";
import type { Me, UserPublic } from "../../shared/types";
import { quietEndsAt, type QuietSettings } from "../../shared/quietHours";
import { relationsFor } from "./blocks";

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  bio: string;
  password_hash: string | null;
  is_bot: number;
  is_demo: number;
  bot_kind: string | null;
  avatar_hue: number;
  time_zone: string;
  quiet_enabled: number;
  quiet_start: number;
  quiet_end: number;
  show_local_time: number;
  last_seen_at: number | null;
  created_at: number;
}

export function getUser(ctx: AppContext, id: number): Promise<UserRow | undefined> {
  return ctx.db.one<UserRow>("SELECT * FROM users WHERE id = ?", id);
}

export function quietOf(u: UserRow): QuietSettings {
  return { enabled: !!u.quiet_enabled && !u.is_bot, start: u.quiet_start, end: u.quiet_end, timeZone: u.time_zone };
}

/** What other people may see about a user. Never includes password hash or session data. */
export function toPublicUser(
  ctx: AppContext,
  u: UserRow,
  rel: { blockedByMe?: boolean; blockedMe?: boolean } = {},
): UserPublic {
  const showTime = !!u.show_local_time;
  const q = quietOf(u);
  let quiet: UserPublic["quiet"] = null;
  if (q.enabled) {
    const endsAt = quietEndsAt(ctx.now(), q);
    quiet = {
      active: endsAt !== null,
      endsAt,
      // The exact window reveals someone's sleep schedule — only shared if they share local time.
      start: showTime ? q.start : null,
      end: showTime ? q.end : null,
    };
  }
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    bio: u.bio,
    avatarHue: u.avatar_hue,
    isBot: !!u.is_bot,
    // Someone who blocked me shows as "last seen a long time ago", like in Telegram.
    online: !!u.is_bot || (!rel.blockedMe && ctx.hub.isOnline(u.id)),
    lastSeenAt: u.is_bot || rel.blockedMe ? null : u.last_seen_at,
    timeZone: showTime && !u.is_bot ? u.time_zone : null,
    quiet,
    blockedByMe: !!rel.blockedByMe,
  };
}

/** Public profiles as seen by a particular viewer (block relations applied). */
export async function publicUsersFor(ctx: AppContext, viewerId: number, rows: UserRow[]): Promise<UserPublic[]> {
  const { iBlocked, blockedMe } = await relationsFor(
    ctx,
    viewerId,
    rows.map((u) => u.id),
  );
  return rows.map((u) => toPublicUser(ctx, u, { blockedByMe: iBlocked.has(u.id), blockedMe: blockedMe.has(u.id) }));
}

export async function toMe(ctx: AppContext, u: UserRow): Promise<Me> {
  const held = await ctx.db.one<{ n: number; until: number | null }>(
    `SELECT COUNT(*) AS n, MIN(m.deliver_at) AS until
       FROM messages m
       JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
      WHERE m.deliver_at IS NOT NULL AND m.sender_id <> ?`,
    u.id,
    u.id,
  );
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    bio: u.bio,
    avatarHue: u.avatar_hue,
    isDemo: !!u.is_demo,
    quiet: { enabled: !!u.quiet_enabled, start: u.quiet_start, end: u.quiet_end, timeZone: u.time_zone },
    showLocalTime: !!u.show_local_time,
    heldCount: held?.n ?? 0,
    heldUntil: held?.until ?? null,
  };
}

/** Ids of everyone who shares at least one chat with the user (for presence updates). */
export async function contactIds(ctx: AppContext, userId: number): Promise<number[]> {
  const rows = await ctx.db.all<{ id: number }>(
    `SELECT DISTINCT other.user_id AS id
       FROM chat_members mine
       JOIN chat_members other ON other.chat_id = mine.chat_id AND other.user_id <> mine.user_id
      WHERE mine.user_id = ?`,
    userId,
  );
  return rows.map((r) => r.id);
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export async function searchUsers(ctx: AppContext, meId: number, q: string): Promise<UserPublic[]> {
  const query = q.trim().replace(/^@/, "").slice(0, 64);
  let rows: UserRow[];
  if (!query) {
    rows = await ctx.db.all<UserRow>(
      `SELECT u.* FROM users u
        WHERE u.id <> ? AND (u.is_bot = 1 OR u.id IN (
          SELECT other.user_id FROM chat_members mine
            JOIN chat_members other ON other.chat_id = mine.chat_id
           WHERE mine.user_id = ?))
        ORDER BY u.is_bot, lower(u.display_name) LIMIT 50`,
      meId,
      meId,
    );
  } else {
    const like = `%${escapeLike(query)}%`;
    rows = await ctx.db.all<UserRow>(
      `SELECT * FROM users
        WHERE id <> ? AND (username ILIKE ? ESCAPE '\\' OR display_name ILIKE ? ESCAPE '\\')
        ORDER BY (lower(username) = lower(?)) DESC, lower(display_name) LIMIT 20`,
      meId,
      like,
      like,
      query,
    );
  }
  return publicUsersFor(ctx, meId, rows);
}

export async function touchLastSeen(ctx: AppContext, userId: number) {
  await ctx.db.run("UPDATE users SET last_seen_at = ? WHERE id = ?", ctx.now(), userId);
}
