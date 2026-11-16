import { HttpError, type AppContext } from "../context";
import { getDummyHash, hashPassword, hashToken, hueFor, newSessionToken, verifyPassword } from "../security";
import type { SessionDto } from "../../shared/types";
import type { UserRow } from "./users";

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
const TOUCH_EVERY_MS = 60_000;

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === "23505";

export async function registerUser(
  ctx: AppContext,
  input: { username: string; displayName: string; password: string; timeZone?: string },
): Promise<number> {
  const taken = await ctx.db.one("SELECT 1 FROM users WHERE lower(username) = lower(?)", input.username);
  if (taken) throw new HttpError(409, "Це ім'я користувача вже зайняте");
  const hash = await hashPassword(input.password);
  try {
    const row = await ctx.db.one<{ id: number }>(
      `INSERT INTO users (username, display_name, password_hash, avatar_hue, time_zone, created_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      input.username,
      input.displayName,
      hash,
      hueFor(input.username),
      input.timeZone ?? "Europe/Kyiv",
      ctx.now(),
    );
    return row!.id;
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "Це ім'я користувача вже зайняте");
    throw err;
  }
}

/** Same error and roughly the same time for "no such user" and "wrong password". */
export async function authenticate(ctx: AppContext, username: string, password: string): Promise<UserRow> {
  const user = await ctx.db.one<UserRow>("SELECT * FROM users WHERE lower(username) = lower(?) AND is_bot = 0", username);
  const ok = await verifyPassword(password, user?.password_hash ?? (await getDummyHash()));
  if (!user || !user.password_hash || !ok) throw new HttpError(401, "Невірне ім'я користувача або пароль");
  return user;
}

/** Re-check the password of a logged-in user (before destructive actions). */
export async function confirmPassword(user: UserRow, password: string) {
  if (!user.password_hash || !(await verifyPassword(password, user.password_hash))) {
    throw new HttpError(403, "Невірний пароль");
  }
}

export async function createSession(ctx: AppContext, userId: number, userAgent: string): Promise<string> {
  const token = newSessionToken();
  const now = ctx.now();
  await ctx.db.run(
    `INSERT INTO sessions (user_id, token_hash, user_agent, created_at, last_active_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    userId,
    hashToken(token),
    userAgent.slice(0, 200),
    now,
    now,
    now + SESSION_TTL_MS,
  );
  return token;
}

export interface SessionInfo {
  sessionId: number;
  user: UserRow;
}

export async function resolveSession(ctx: AppContext, token: string | undefined): Promise<SessionInfo | null> {
  if (!token || token.length > 100) return null;
  const now = ctx.now();
  const row = await ctx.db.one<UserRow & { session_id: number; last_active_at: number; expires_at: number }>(
    `SELECT u.*, s.id AS session_id, s.last_active_at, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    hashToken(token),
  );
  if (!row) return null;
  if (row.expires_at <= now) {
    await ctx.db.run("DELETE FROM sessions WHERE id = ?", row.session_id);
    return null;
  }
  if (now - row.last_active_at > TOUCH_EVERY_MS) {
    // Sliding expiration, written at most once a minute.
    await ctx.db.run(
      "UPDATE sessions SET last_active_at = ?, expires_at = ? WHERE id = ?",
      now,
      now + SESSION_TTL_MS,
      row.session_id,
    );
  }
  const { session_id, last_active_at: _a, expires_at: _e, ...user } = row;
  return { sessionId: session_id, user: user as UserRow };
}

export async function sessionExists(ctx: AppContext, sessionId: number): Promise<boolean> {
  return !!(await ctx.db.one("SELECT 1 FROM sessions WHERE id = ?", sessionId));
}

export async function destroySession(ctx: AppContext, token: string | undefined) {
  if (token) await ctx.db.run("DELETE FROM sessions WHERE token_hash = ?", hashToken(token));
}

export async function listSessions(ctx: AppContext, userId: number, currentId: number): Promise<SessionDto[]> {
  const rows = await ctx.db.all<{ id: number; user_agent: string; created_at: number; last_active_at: number }>(
    "SELECT id, user_agent, created_at, last_active_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_active_at DESC",
    userId,
    ctx.now(),
  );
  return rows.map((s) => ({
    id: s.id,
    userAgent: s.user_agent,
    createdAt: s.created_at,
    lastActiveAt: s.last_active_at,
    current: s.id === currentId,
  }));
}

/** Only your own sessions can be terminated — the user_id filter is the authorization check. */
export async function revokeSession(ctx: AppContext, userId: number, sessionId: number): Promise<boolean> {
  return (await ctx.db.run("DELETE FROM sessions WHERE id = ? AND user_id = ?", sessionId, userId)) > 0;
}

export function revokeOtherSessions(ctx: AppContext, userId: number, currentId: number): Promise<number> {
  return ctx.db.run("DELETE FROM sessions WHERE user_id = ? AND id <> ?", userId, currentId);
}

/** Housekeeping: drop expired sessions. */
export function purgeExpiredSessions(ctx: AppContext): Promise<number> {
  return ctx.db.run("DELETE FROM sessions WHERE expires_at <= ?", ctx.now());
}

/**
 * Account deletion (right to be forgotten): the user, their sessions, memberships,
 * reactions and messages are removed by ON DELETE CASCADE. Groups they created stay for the others.
 */
export async function deleteAccount(ctx: AppContext, userId: number) {
  await ctx.db.tx(async (db) => {
    // Private chats with this user become empty shells for the other side — remove them entirely.
    await db.run(
      `DELETE FROM chats WHERE type = 'private' AND id IN (SELECT chat_id FROM chat_members WHERE user_id = ?)`,
      userId,
    );
    await db.run("DELETE FROM users WHERE id = ?", userId);
  });
}
