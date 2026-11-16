import type {
  ChatDetail,
  ChatSummary,
  DeliveryMode,
  Me,
  MessageDto,
  MessagesPage,
  SessionDto,
  UserPublic,
} from "../../shared/types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (method !== "GET" && (method !== "DELETE" || body !== undefined)) {
    // Always JSON: the server rejects other content types as a CSRF defence.
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body ?? {});
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(0, "Немає з'єднання з сервером");
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) {
    if (res.status === 401 && path !== "/me" && !path.startsWith("/auth/")) onUnauthorized?.();
    throw new ApiError(res.status, data?.error ?? `Помилка ${res.status}`);
  }
  return data as T;
}

export type MePatch = Partial<{
  displayName: string;
  username: string;
  bio: string;
  timeZone: string;
  quietEnabled: boolean;
  quietStart: number;
  quietEnd: number;
  showLocalTime: boolean;
}>;

export const api = {
  me: () => request<Me>("GET", "/me"),
  login: (username: string, password: string) => request<Me>("POST", "/auth/login", { username, password }),
  register: (input: { username: string; displayName: string; password: string; timeZone?: string }) =>
    request<Me>("POST", "/auth/register", input),
  logout: () => request<void>("POST", "/auth/logout"),
  updateMe: (patch: MePatch) => request<Me>("PATCH", "/me", patch),
  releaseHeld: () => request<{ released: number }>("POST", "/me/held/release"),
  sessions: () => request<SessionDto[]>("GET", "/me/sessions"),
  revokeSession: (id: number) => request<void>("DELETE", `/me/sessions/${id}`),
  revokeOtherSessions: () => request<{ terminated: number }>("POST", "/me/sessions/terminate-others"),
  deleteAccount: (password: string) => request<void>("DELETE", "/me", { password }),

  searchUsers: (q: string) => request<UserPublic[]>("GET", `/users/search?q=${encodeURIComponent(q)}`),

  chats: () => request<ChatSummary[]>("GET", "/chats"),
  chat: (id: number) => request<ChatDetail>("GET", `/chats/${id}`),
  openPrivate: (userId: number) => request<ChatDetail>("POST", "/chats/private", { userId }),
  createGroup: (title: string, memberIds: number[]) => request<ChatDetail>("POST", "/chats/group", { title, memberIds }),
  updateChat: (id: number, patch: { pinned?: boolean; muted?: boolean }) =>
    request<ChatDetail>("PATCH", `/chats/${id}`, patch),

  messages: (chatId: number, before?: string | null) =>
    request<MessagesPage>("GET", `/chats/${chatId}/messages${before ? `?before=${encodeURIComponent(before)}` : ""}`),
  send: (chatId: number, input: { text: string; replyToId?: number | null; delivery: DeliveryMode }) =>
    request<MessageDto>("POST", `/chats/${chatId}/messages`, input),
  read: (chatId: number, upTo: number) => request<void>("POST", `/chats/${chatId}/read`, { upTo }),
  typing: (chatId: number) => request<void>("POST", `/chats/${chatId}/typing`),
  edit: (id: number, text: string) => request<MessageDto>("PATCH", `/messages/${id}`, { text }),
  remove: (id: number) => request<void>("DELETE", `/messages/${id}`),
  deliverNow: (id: number) => request<MessageDto>("POST", `/messages/${id}/deliver-now`),
  react: (id: number, emoji: string | null) => request<MessageDto>("PUT", `/messages/${id}/reaction`, { emoji }),
};
