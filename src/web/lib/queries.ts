import { useInfiniteQuery, useQuery, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { ChatDetail, ChatSummary, MessagesPage } from "../../shared/types";
import type { ClientMessage } from "./messages";

export const qk = {
  me: ["me"] as const,
  chats: ["chats"] as const,
  chat: (id: number) => ["chat", id] as const,
  messages: (id: number) => ["messages", id] as const,
  sessions: ["sessions"] as const,
  search: (q: string) => ["search", q] as const,
};

export const useMe = () => useQuery({ queryKey: qk.me, queryFn: api.me, retry: false, staleTime: 30_000 });

export const useChats = () => useQuery({ queryKey: qk.chats, queryFn: api.chats, staleTime: 15_000 });

/** Re-fetched every minute: the peer's quiet-hours status changes with the clock. */
export const useChat = (id: number) =>
  useQuery({ queryKey: qk.chat(id), queryFn: () => api.chat(id), refetchInterval: 60_000, retry: false });

export const useMessages = (chatId: number) =>
  useInfiniteQuery({
    queryKey: qk.messages(chatId),
    queryFn: ({ pageParam }) => api.messages(chatId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    staleTime: 30_000,
  });

type MessagesData = InfiniteData<MessagesPage, string | null>;

/** Insert or replace a message in the cached history (newest page = pages[0]). */
export function upsertMessage(qc: QueryClient, message: ClientMessage) {
  qc.setQueryData<MessagesData>(qk.messages(message.chatId), (data) => {
    if (!data) return data;
    let found = false;
    // The realtime echo of my own message may arrive before the HTTP response:
    // let it replace the optimistic copy instead of showing a duplicate.
    const isMatch = (m: ClientMessage) =>
      m.id === message.id ||
      (message.id > 0 && m.id < 0 && m.status === "sending" && m.senderId === message.senderId && m.text === message.text);
    const pages = data.pages.map((p) => {
      if (found || !p.messages.some(isMatch)) return p;
      found = true;
      const idx = p.messages.findIndex(isMatch);
      const next = [...p.messages];
      next[idx] = message;
      return { ...p, messages: next.filter((m, i) => i === idx || m.id !== message.id) };
    });
    if (!found && pages[0]) pages[0] = { ...pages[0], messages: [...pages[0].messages, message] };
    return { ...data, pages };
  });
}

export function removeMessage(qc: QueryClient, chatId: number, id: number) {
  qc.setQueryData<MessagesData>(qk.messages(chatId), (data) =>
    data ? { ...data, pages: data.pages.map((p) => ({ ...p, messages: p.messages.filter((m) => m.id !== id) })) } : data,
  );
}

export function patchChat(qc: QueryClient, chatId: number, patch: (c: ChatSummary) => Partial<ChatSummary>) {
  qc.setQueryData<ChatDetail>(qk.chat(chatId), (c) => (c ? { ...c, ...patch(c) } : c));
  qc.setQueryData<ChatSummary[]>(qk.chats, (list) => list?.map((c) => (c.id === chatId ? { ...c, ...patch(c) } : c)));
}

let chatsTimer: ReturnType<typeof setTimeout> | null = null;
/** Coalesce bursts of events into one chat-list refetch. */
export function refreshChatsSoon(qc: QueryClient) {
  if (chatsTimer) return;
  chatsTimer = setTimeout(() => {
    chatsTimer = null;
    void qc.invalidateQueries({ queryKey: qk.chats });
  }, 150);
}

/** A chat was deleted (by me, or for everyone by the other side): drop it from every cache. */
export function forgetChat(qc: QueryClient, chatId: number) {
  qc.setQueryData<ChatSummary[]>(qk.chats, (list) => list?.filter((c) => c.id !== chatId));
  void qc.resetQueries({ queryKey: qk.messages(chatId) });
  void qc.invalidateQueries({ queryKey: qk.chat(chatId) });
  refreshChatsSoon(qc);
}
