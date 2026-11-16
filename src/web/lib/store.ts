import { useSyncExternalStore } from "react";

/** Minimal external store for fast-changing UI state (typing, presence, connection). */
export function createStore<T>(initial: T) {
  let state = initial;
  const subscribers = new Set<() => void>();
  return {
    get: () => state,
    set(next: T | ((prev: T) => T)) {
      state = typeof next === "function" ? (next as (prev: T) => T)(state) : next;
      subscribers.forEach((fn) => fn());
    },
    subscribe(fn: () => void) {
      subscribers.add(fn);
      return () => void subscribers.delete(fn);
    },
  };
}

type Store<T> = ReturnType<typeof createStore<T>>;

/** Selector must return a stable value (primitive or an existing reference). */
export function useStore<T, S>(store: Store<T>, selector: (state: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}

export type ConnectionState = "online" | "connecting" | "offline";
export const connectionStore = createStore<ConnectionState>("connecting");

/** chatId → userId → typer */
export const typingStore = createStore<Record<number, Record<number, { name: string; until: number }>>>({});

/** Live presence overrides on top of what the API returned. */
export const presenceStore = createStore<Record<number, { online: boolean; lastSeenAt: number | null }>>({});

const TYPING_MS = 5000;

export function setTyping(chatId: number, userId: number, name: string) {
  typingStore.set((s) => ({ ...s, [chatId]: { ...s[chatId], [userId]: { name, until: Date.now() + TYPING_MS } } }));
  setTimeout(() => clearTyping(chatId, userId, true), TYPING_MS + 50);
}

export function clearTyping(chatId: number, userId: number, onlyExpired = false) {
  typingStore.set((s) => {
    const entry = s[chatId]?.[userId];
    if (!entry || (onlyExpired && entry.until > Date.now())) return s;
    const { [userId]: _removed, ...rest } = s[chatId]!;
    return { ...s, [chatId]: rest };
  });
}

const EMPTY = {};
export function useTyping(chatId: number) {
  return useStore(typingStore, (s) => s[chatId] ?? EMPTY) as Record<number, { name: string; until: number }>;
}

export function usePresence(userId: number | undefined, fallback: { online: boolean; lastSeenAt: number | null }) {
  const live = useStore(presenceStore, (s) => (userId ? s[userId] : undefined));
  return live ?? fallback;
}
