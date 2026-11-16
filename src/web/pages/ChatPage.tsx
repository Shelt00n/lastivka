import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft } from "lucide-react";
import type { DeliveryMode, Me, Reaction } from "../../shared/types";
import { Avatar } from "../components/Avatar";
import { Composer } from "../components/Composer";
import { MessageBubble } from "../components/MessageBubble";
import { MessageMenu } from "../components/MessageMenu";
import { toast } from "../components/Toast";
import { ConnectionTitle } from "./ChatsPage";
import { api, ApiError } from "../lib/api";
import { buildRows, sortMessages, type ClientMessage } from "../lib/messages";
import { patchChat, refreshChatsSoon, removeMessage, upsertMessage, useChat, useChats, useMessages } from "../lib/queries";
import { usePresence, useTyping } from "../lib/store";
import { formatLastSeen, formatMembers } from "../lib/format";

const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

function nextReactions(list: Reaction[], emoji: string | null): Reaction[] {
  const without = list
    .map((r) => (r.mine ? { ...r, count: r.count - 1, mine: false } : r))
    .filter((r) => r.count > 0);
  if (!emoji) return without;
  const existing = without.find((r) => r.emoji === emoji);
  return existing
    ? without.map((r) => (r.emoji === emoji ? { ...r, count: r.count + 1, mine: true } : r))
    : [...without, { emoji, count: 1, mine: true }];
}

function useVisibilityTick() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    document.addEventListener("visibilitychange", on);
    window.addEventListener("focus", on);
    return () => {
      document.removeEventListener("visibilitychange", on);
      window.removeEventListener("focus", on);
    };
  }, []);
  return tick;
}

function ChatSubtitle({ chatId }: { chatId: number }) {
  const { data: chat } = useChat(chatId);
  const typing = Object.values(useTyping(chatId)).filter((t) => t.until > Date.now());
  const peer = chat?.peer;
  const presence = usePresence(peer?.id, { online: peer?.online ?? false, lastSeenAt: peer?.lastSeenAt ?? null });
  if (!chat || chat.isSaved) return null;
  if (typing.length > 0) {
    const who = chat.type === "group" ? `${typing[0]!.name.split(" ")[0]} друкує` : "друкує";
    return (
      <span className="topbar__subtitle topbar__subtitle--accent">
        {who}
        <span className="dots" />
      </span>
    );
  }
  if (chat.type === "group") {
    const online = chat.members.filter((m) => m.online).length;
    return (
      <span className="topbar__subtitle">
        {formatMembers(chat.memberCount)}
        {online > 1 ? `, ${online} в мережі` : ""}
      </span>
    );
  }
  if (peer?.isBot) return <span className="topbar__subtitle">бот</span>;
  return (
    <span className={`topbar__subtitle${presence.online ? " topbar__subtitle--accent" : ""}`}>
      {formatLastSeen(presence.online, presence.lastSeenAt)}
    </span>
  );
}

export function ChatPage({ me }: { me: Me }) {
  const chatId = Number(useParams().id);
  const qc = useQueryClient();
  const chatQ = useChat(chatId);
  const msgsQ = useMessages(chatId);
  const { data: allChats } = useChats();
  const chat = chatQ.data;

  const [replyTo, setReplyTo] = useState<ClientMessage | null>(null);
  const [editing, setEditing] = useState<ClientMessage | null>(null);
  const [menuMsg, setMenuMsg] = useState<ClientMessage | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const readSent = useRef(0);
  const unreadAfter = useRef<number | null | undefined>(undefined);
  const jumpedToUnread = useRef(false);
  const visibility = useVisibilityTick();

  // Remember where unread started when the chat was opened (for the divider).
  if (chat && unreadAfter.current === undefined) unreadAfter.current = chat.unreadCount > 0 ? chat.myReadAt : null;

  const messages = useMemo(
    () => sortMessages((msgsQ.data?.pages.flatMap((p) => p.messages) ?? []) as ClientMessage[]),
    [msgsQ.data],
  );
  const rows = useMemo(
    () =>
      buildRows(messages, {
        meId: me.id,
        unreadAfter: unreadAfter.current ?? null,
        heldLabel: "🌙 Прийдуть після тихих годин",
      }),
    [messages, me.id],
  );

  const lastIncoming = useMemo(
    () => [...messages].reverse().find((m) => m.senderId !== me.id && m.deliverAt === null && m.id > 0),
    [messages, me.id],
  );
  const unseen = messages.filter(
    (m) => m.senderId !== me.id && m.deliverAt === null && m.createdAt > Math.max(chat?.myReadAt ?? 0, readSent.current),
  ).length;

  const botButtons = useMemo(() => {
    if (!chat?.peer?.isBot) return null;
    return [...messages].reverse().find((m) => m.senderId === chat.peer!.id)?.buttons ?? null;
  }, [messages, chat?.peer]);

  // ---------- scrolling (column-reverse: scrollTop 0 = bottom, negative upwards) ----------

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(-el.scrollTop < 80);
    const fromTop = el.scrollHeight - el.clientHeight + el.scrollTop;
    if (fromTop < 400 && msgsQ.hasNextPage && !msgsQ.isFetchingNextPage) void msgsQ.fetchNextPage();
  };

  const scrollToBottom = (smooth = true) => scrollRef.current?.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });

  // Short history that doesn't fill the screen → keep loading older pages.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollHeight <= el.clientHeight && msgsQ.hasNextPage && !msgsQ.isFetchingNextPage) {
      void msgsQ.fetchNextPage();
    }
  }, [rows.length, msgsQ]);

  // Like Telegram: open long unread threads at the first unread message.
  useLayoutEffect(() => {
    if (jumpedToUnread.current || rows.length === 0) return;
    jumpedToUnread.current = true;
    const divider = document.getElementById("unread-divider");
    if (divider && unseen > 3) divider.scrollIntoView({ block: "start" });
  }, [rows.length, unseen]);

  // ---------- read receipts ----------

  useEffect(() => {
    if (!chat || !lastIncoming || !atBottom || document.visibilityState !== "visible") return;
    if (lastIncoming.createdAt <= Math.max(chat.myReadAt, readSent.current)) return;
    readSent.current = lastIncoming.createdAt;
    void api.read(chatId, lastIncoming.createdAt).catch(() => {});
    patchChat(qc, chatId, (c) => ({ myReadAt: Math.max(c.myReadAt, lastIncoming.createdAt), unreadCount: 0 }));
  }, [chat, lastIncoming, atBottom, visibility, chatId, qc]);

  // ---------- actions ----------

  const send = async (text: string, delivery: DeliveryMode) => {
    const tempId = -Date.now();
    const quiet = chat?.peer?.quiet;
    const optimistic: ClientMessage = {
      id: tempId,
      chatId,
      senderId: me.id,
      senderName: me.displayName,
      senderHue: me.avatarHue,
      text,
      createdAt: Date.now(),
      editedAt: null,
      deliverAt: delivery === "gentle" && quiet?.active && quiet.endsAt ? quiet.endsAt : null,
      replyTo: replyTo ? { id: replyTo.id, senderName: replyTo.senderName, text: replyTo.text } : null,
      reactions: [],
      buttons: null,
      status: "sending",
    };
    upsertMessage(qc, optimistic);
    setReplyTo(null);
    requestAnimationFrame(() => scrollToBottom());
    try {
      const real = await api.send(chatId, { text, replyToId: optimistic.replyTo?.id ?? null, delivery });
      removeMessage(qc, chatId, tempId);
      upsertMessage(qc, real);
      refreshChatsSoon(qc);
    } catch (e) {
      upsertMessage(qc, { ...optimistic, status: "failed" });
      toast(errorText(e, "Не вдалося надіслати"));
    }
  };

  const saveEdit = async (m: ClientMessage, text: string) => {
    setEditing(null);
    upsertMessage(qc, { ...m, text, editedAt: Date.now() });
    try {
      upsertMessage(qc, await api.edit(m.id, text));
      refreshChatsSoon(qc);
    } catch (e) {
      upsertMessage(qc, m);
      toast(errorText(e, "Не вдалося зберегти"));
    }
  };

  const remove = async (m: ClientMessage) => {
    removeMessage(qc, chatId, m.id);
    if (m.id < 0) return; // failed optimistic copy: local only
    try {
      await api.remove(m.id);
      refreshChatsSoon(qc);
    } catch (e) {
      upsertMessage(qc, m);
      toast(errorText(e, "Не вдалося видалити"));
    }
  };

  const react = useCallback(
    async (m: ClientMessage, emoji: string | null) => {
      upsertMessage(qc, { ...m, reactions: nextReactions(m.reactions, emoji) });
      try {
        upsertMessage(qc, await api.react(m.id, emoji));
      } catch (e) {
        upsertMessage(qc, m);
        toast(errorText(e, "Не вдалося додати реакцію"));
      }
    },
    [qc],
  );

  const quickReact = useCallback(
    (m: ClientMessage) => void react(m, m.reactions.find((r) => r.mine)?.emoji === "👍" ? null : "👍"),
    [react],
  );
  const toggleReaction = useCallback(
    (m: ClientMessage, emoji: string) => void react(m, m.reactions.find((r) => r.mine)?.emoji === emoji ? null : emoji),
    [react],
  );

  const deliverNow = async (m: ClientMessage) => {
    try {
      upsertMessage(qc, await api.deliverNow(m.id));
      toast("Надіслано зараз");
      refreshChatsSoon(qc);
    } catch (e) {
      toast(errorText(e, "Не вдалося надіслати"));
    }
  };

  const jumpTo = useCallback((id: number) => {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return toast("Повідомлення поза завантаженою історією");
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("msg--flash");
    setTimeout(() => el.classList.remove("msg--flash"), 1200);
  }, []);

  const otherUnread = (allChats ?? []).filter((c) => c.id !== chatId && !c.muted).reduce((n, c) => n + c.unreadCount, 0);

  if (chatQ.error) {
    return (
      <div className="screen">
        <header className="topbar">
          <Link to="/" className="back-btn">
            <ChevronLeft size={28} />
            Чати
          </Link>
        </header>
        <p className="empty-hint">Чат не знайдено або у вас немає доступу.</p>
      </div>
    );
  }

  return (
    <div className="screen screen--chat">
      <header className="topbar topbar--chat">
        <Link to="/" className="back-btn" aria-label="Назад до чатів">
          <ChevronLeft size={28} />
          {otherUnread > 0 ? <span className="back-btn__count">{otherUnread}</span> : "Чати"}
        </Link>
        <Link to={`/chat/${chatId}/info`} className="topbar__center">
          <span className="topbar__title truncate">
            {chat ? chat.title : <ConnectionTitle fallback="…" />}
          </span>
          <ChatSubtitle chatId={chatId} />
        </Link>
        <Link to={`/chat/${chatId}/info`} className="topbar__avatar" aria-label="Інформація">
          {chat && <Avatar name={chat.title} hue={chat.avatarHue} saved={chat.isSaved} size={38} />}
        </Link>
      </header>

      <div className="chat-area">
        <div className="chat-bg" aria-hidden="true" />
        <div className="messages" ref={scrollRef} onScroll={onScroll}>
          <div className="messages__inner">
            {msgsQ.isFetchingNextPage && (
              <div className="load-more">
                <span className="spinner" />
              </div>
            )}
            {msgsQ.isSuccess && messages.length === 0 && (
              <div className="empty-chat">
                <b>{chat?.isSaved ? "Ваш особистий простір" : "Тут поки тихо"}</b>
                <span>{chat?.isSaved ? "Зберігайте нотатки й посилання — їх бачите лише ви." : "Надішліть перше повідомлення 👋"}</span>
              </div>
            )}
            {rows.map((row) =>
              row.kind === "day" ? (
                <div key={row.key} className={`day-pill${row.held ? " day-pill--held" : ""}`}>
                  <span>{row.label}</span>
                </div>
              ) : row.kind === "unread" ? (
                <div key={row.key} id="unread-divider" className="unread-divider">
                  Непрочитані повідомлення
                </div>
              ) : (
                <MessageBubble
                  key={row.key}
                  message={row.message}
                  mine={row.message.senderId === me.id}
                  first={row.first}
                  last={row.last}
                  read={!!chat && chat.peerReadAt >= row.message.createdAt}
                  showSender={chat?.type === "group"}
                  onMenu={setMenuMsg}
                  onQuickReact={quickReact}
                  onReplyClick={jumpTo}
                  onToggleReaction={toggleReaction}
                />
              ),
            )}
          </div>
        </div>
        {!atBottom && (
          <button type="button" className="fab-down" aria-label="До останніх повідомлень" onClick={() => scrollToBottom()}>
            <ChevronDown size={26} />
            {unseen > 0 && <span className="badge">{unseen}</span>}
          </button>
        )}
      </div>

      {chat && (
        <Composer
          chat={chat}
          replyTo={replyTo}
          editing={editing}
          botButtons={botButtons}
          onCancel={() => {
            setReplyTo(null);
            setEditing(null);
          }}
          onSend={send}
          onSaveEdit={saveEdit}
        />
      )}

      <MessageMenu
        message={menuMsg}
        meId={me.id}
        onClose={() => setMenuMsg(null)}
        onReply={(m) => {
          setEditing(null);
          setReplyTo(m);
        }}
        onEdit={(m) => {
          setReplyTo(null);
          setEditing(m);
        }}
        onDelete={remove}
        onDeliverNow={deliverNow}
        onReact={(m, emoji) => void react(m, emoji)}
        onCopy={(m) =>
          navigator.clipboard?.writeText(m.text).then(
            () => toast("Скопійовано"),
            () => toast("Не вдалося скопіювати"),
          )
        }
        onRetry={(m) => {
          removeMessage(qc, chatId, m.id);
          void send(m.text, m.deliverAt ? "gentle" : "now");
        }}
      />
    </div>
  );
}
