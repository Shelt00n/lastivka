import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { ServerEvent } from "../../shared/types";
import { api, ApiError } from "./api";
import { patchChat, qk, refreshChatsSoon, removeMessage, upsertMessage } from "./queries";
import { clearTyping, connectionStore, presenceStore, setTyping } from "./store";

function handle(qc: QueryClient, meId: number, event: ServerEvent) {
  switch (event.type) {
    case "message.new":
    case "message.updated":
      upsertMessage(qc, event.message);
      if (event.message.senderId !== meId) clearTyping(event.message.chatId, event.message.senderId);
      refreshChatsSoon(qc);
      break;
    case "message.deleted":
      removeMessage(qc, event.chatId, event.messageId);
      refreshChatsSoon(qc);
      break;
    case "chat.read":
      if (event.userId === meId) {
        patchChat(qc, event.chatId, (c) => ({ myReadAt: Math.max(c.myReadAt, event.readAt) }));
        refreshChatsSoon(qc);
      } else {
        patchChat(qc, event.chatId, (c) => ({ peerReadAt: Math.max(c.peerReadAt, event.readAt) }));
      }
      break;
    case "chat.new":
      refreshChatsSoon(qc);
      break;
    case "typing":
      if (event.userId !== meId) setTyping(event.chatId, event.userId, event.name);
      break;
    case "presence":
      presenceStore.set((s) => ({ ...s, [event.userId]: { online: event.online, lastSeenAt: event.lastSeenAt } }));
      break;
    case "me.updated":
      void qc.invalidateQueries({ queryKey: qk.me });
      refreshChatsSoon(qc);
      break;
  }
}

/** One SSE stream per tab; reconnects with backoff and resyncs caches after a gap. */
export function useRealtime(meId: number | undefined) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!meId) return;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;

    const connect = () => {
      connectionStore.set("connecting");
      source = new EventSource("/api/events");
      source.addEventListener("ready", () => {
        if (attempt > 0) void qc.invalidateQueries(); // we may have missed events while offline
        attempt = 0;
        connectionStore.set("online");
      });
      source.onmessage = (e) => {
        try {
          handle(qc, meId, JSON.parse(e.data) as ServerEvent);
        } catch (err) {
          console.error("bad event", err);
        }
      };
      source.onerror = () => {
        source?.close();
        if (stopped) return;
        connectionStore.set("offline");
        // Distinguish "network down" from "session ended".
        api.me().then(
          () => retry(),
          (err) => {
            if (err instanceof ApiError && err.status === 401) void qc.invalidateQueries({ queryKey: qk.me });
            else retry();
          },
        );
      };
    };

    const retry = () => {
      attempt += 1;
      timer = setTimeout(connect, Math.min(1000 * 2 ** attempt, 15_000));
    };

    connect();
    return () => {
      stopped = true;
      source?.close();
      clearTimeout(timer);
    };
  }, [meId, qc]);
}
