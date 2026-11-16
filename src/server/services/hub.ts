import type { ServerEvent } from "../../shared/types";

type Listener = (event: ServerEvent) => void;

/** One user may not hold more live streams than this (tabs/devices). */
export const MAX_STREAMS_PER_USER = 10;

/**
 * In-process pub/sub for Server-Sent Events.
 * Each open browser tab is one listener; a user may have several.
 * Events are addressed to user ids — the caller decides who may see what.
 */
export class Hub {
  private listeners = new Map<number, Set<Listener>>();

  constructor(private readonly onPresence?: (userId: number, online: boolean) => void) {}

  streamCount(userId: number): number {
    return this.listeners.get(userId)?.size ?? 0;
  }

  subscribe(userId: number, listener: Listener): () => void {
    let set = this.listeners.get(userId);
    const wasOffline = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.listeners.set(userId, set);
    }
    set.add(listener);
    if (wasOffline) this.onPresence?.(userId, true);

    return () => {
      const current = this.listeners.get(userId);
      if (!current || !current.delete(listener)) return;
      if (current.size === 0) {
        this.listeners.delete(userId);
        this.onPresence?.(userId, false);
      }
    };
  }

  isOnline(userId: number): boolean {
    return this.streamCount(userId) > 0;
  }

  private emit(userId: number, payload: ServerEvent) {
    for (const listener of this.listeners.get(userId) ?? []) {
      try {
        listener(payload);
      } catch {
        // A broken stream must not affect other subscribers.
      }
    }
  }

  /** Send the same event to users (only those online receive it). */
  publish(userIds: Iterable<number>, event: ServerEvent) {
    for (const userId of new Set(userIds)) this.emit(userId, event);
  }

  /** Build a per-viewer payload (e.g. "mine" flags) — only for users who are online right now. */
  async publishEach(userIds: Iterable<number>, build: (userId: number) => Promise<ServerEvent | null>) {
    for (const userId of new Set(userIds)) {
      if (!this.isOnline(userId)) continue;
      const payload = await build(userId);
      if (payload) this.emit(userId, payload);
    }
  }
}
