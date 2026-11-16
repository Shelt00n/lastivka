import { HttpError, notFound, type AppContext } from "../context";
import { getUser } from "./users";

/**
 * Blocking, Telegram-style:
 *  - neither side can send messages in their private chat while a block exists;
 *  - the blocked person stops seeing the blocker's online status and "last seen";
 *  - groups are not affected; the block is invisible to the blocked person except for the failed send.
 */

export async function blockUser(ctx: AppContext, meId: number, targetId: number) {
  if (targetId === meId) throw new HttpError(400, "Не можна заблокувати себе");
  const target = await getUser(ctx, targetId);
  if (!target) throw notFound("Користувача не знайдено");
  if (target.is_bot) throw new HttpError(400, "Ботів не можна блокувати — просто видаліть чат");
  await ctx.db.run(
    "INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    meId,
    targetId,
    ctx.now(),
  );
  // From now on the blocked person sees me as offline with no "last seen".
  ctx.hub.publish([targetId], { type: "presence", userId: meId, online: false, lastSeenAt: null });
}

export async function unblockUser(ctx: AppContext, meId: number, targetId: number) {
  await ctx.db.run("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?", meId, targetId);
}

export async function blockBetween(ctx: AppContext, a: number, b: number) {
  const rows = await ctx.db.all<{ blocker_id: number }>(
    "SELECT blocker_id FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)",
    a,
    b,
    b,
    a,
  );
  return { aBlockedB: rows.some((r) => r.blocker_id === a), bBlockedA: rows.some((r) => r.blocker_id === b) };
}

/** People `userId` has blocked (they must not receive `userId`'s presence). */
export async function blockedBy(ctx: AppContext, userId: number): Promise<Set<number>> {
  const rows = await ctx.db.all<{ id: number }>("SELECT blocked_id AS id FROM blocks WHERE blocker_id = ?", userId);
  return new Set(rows.map((r) => r.id));
}

/** For a viewer: whom they blocked, and who blocked them, among the given users. */
export async function relationsFor(ctx: AppContext, viewerId: number, ids: number[]) {
  const iBlocked = new Set<number>();
  const blockedMe = new Set<number>();
  if (ids.length > 0) {
    const marks = ids.map(() => "?").join(",");
    const rows = await ctx.db.all<{ blocker_id: number; blocked_id: number }>(
      `SELECT blocker_id, blocked_id FROM blocks
        WHERE (blocker_id = ? AND blocked_id IN (${marks})) OR (blocked_id = ? AND blocker_id IN (${marks}))`,
      viewerId,
      ...ids,
      viewerId,
      ...ids,
    );
    for (const r of rows) {
      if (r.blocker_id === viewerId) iBlocked.add(r.blocked_id);
      else blockedMe.add(r.blocker_id);
    }
  }
  return { iBlocked, blockedMe };
}
