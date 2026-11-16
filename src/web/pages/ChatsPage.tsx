import { useDeferredValue, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, Moon, Pin, PinOff, Search, SquarePen } from "lucide-react";
import type { ChatSummary, Me } from "../../shared/types";
import { ChatRow } from "../components/ChatRow";
import { NewChatSheet } from "../components/NewChatSheet";
import { Sheet, SheetAction } from "../components/Sheet";
import { TabBar } from "../components/TabBar";
import { Avatar } from "../components/Avatar";
import { toast } from "../components/Toast";
import { api, ApiError } from "../lib/api";
import { patchChat, qk, useChats } from "../lib/queries";
import { connectionStore, useStore } from "../lib/store";
import { formatTime, pluralUk } from "../lib/format";

type Folder = "all" | "private" | "groups" | "bots";
const FOLDERS: { id: Folder; label: string; test: (c: ChatSummary) => boolean }[] = [
  { id: "all", label: "Усі", test: () => true },
  { id: "private", label: "Особисті", test: (c) => c.type === "private" && !c.peer?.isBot },
  { id: "groups", label: "Групи", test: (c) => c.type === "group" },
  { id: "bots", label: "Боти", test: (c) => !!c.peer?.isBot },
];

let savedScroll = 0;
let savedFolder: Folder = "all";

export function ConnectionTitle({ fallback }: { fallback: string }) {
  const state = useStore(connectionStore, (s) => s);
  if (state === "online") return <>{fallback}</>;
  return (
    <span className="connecting">
      <span className="spinner" />
      {state === "connecting" ? "Оновлення…" : "Очікування мережі…"}
    </span>
  );
}

function HeldBanner({ me }: { me: Me }) {
  const qc = useQueryClient();
  if (me.heldCount === 0 || !me.heldUntil) return null;
  const release = async () => {
    try {
      const { released } = await api.releaseHeld();
      toast(`Отримано ${released} ${pluralUk(released, ["повідомлення", "повідомлення", "повідомлень"])}`);
      void qc.invalidateQueries({ queryKey: qk.me });
      void qc.invalidateQueries({ queryKey: qk.chats });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Не вдалося");
    }
  };
  return (
    <div className="held-banner">
      <Moon size={20} />
      <span>
        <b>Тихі години.</b> {me.heldCount} {pluralUk(me.heldCount, ["повідомлення чекає", "повідомлення чекають", "повідомлень чекають"])}{" "}
        до {formatTime(me.heldUntil)}
      </span>
      <button type="button" onClick={release}>
        Отримати зараз
      </button>
    </div>
  );
}

export function ChatsPage({ me }: { me: Me }) {
  const { data: chats, isPending, error } = useChats();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState<Folder>(savedFolder);
  const [menuChat, setMenuChat] = useState<ChatSummary | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const q = useDeferredValue(query.trim().toLowerCase());

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = savedScroll;
    return () => {
      savedScroll = el?.scrollTop ?? 0;
    };
  }, []);

  const filtered = useMemo(() => {
    const f = FOLDERS.find((x) => x.id === folder)!;
    return (chats ?? []).filter((c) => {
      if (!q) return f.test(c);
      return (
        c.title.toLowerCase().includes(q) ||
        c.peer?.username.toLowerCase().includes(q.replace(/^@/, "")) ||
        c.lastMessage?.text.toLowerCase().includes(q)
      );
    });
  }, [chats, folder, q]);

  // Global search, like Telegram: people you haven't talked to yet.
  const global = useQuery({
    queryKey: qk.search(q),
    queryFn: () => api.searchUsers(q),
    enabled: q.length >= 2,
    staleTime: 10_000,
  });
  const known = new Set((chats ?? []).map((c) => c.peer?.id));
  const strangers = (global.data ?? []).filter((u) => !known.has(u.id));

  const unreadBy = (f: (typeof FOLDERS)[number]) =>
    (chats ?? []).filter((c) => f.test(c) && !c.muted).reduce((n, c) => n + (c.unreadCount > 0 ? 1 : 0), 0);

  const updateChat = async (chat: ChatSummary, patch: { pinned?: boolean; muted?: boolean }) => {
    patchChat(qc, chat.id, () => patch);
    try {
      await api.updateChat(chat.id, patch);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Не вдалося змінити");
    }
    void qc.invalidateQueries({ queryKey: qk.chats });
  };

  const openUser = async (userId: number) => {
    const chat = await api.openPrivate(userId);
    qc.setQueryData(qk.chat(chat.id), chat);
    navigate(`/chat/${chat.id}`);
  };

  return (
    <div className="screen">
      <header className="topbar">
        <span className="topbar__side" />
        <h1 className="topbar__title">
          <ConnectionTitle fallback="Чати" />
        </h1>
        <span className="topbar__side topbar__side--end">
          <button type="button" className="icon-btn icon-btn--accent" aria-label="Нове повідомлення" onClick={() => setComposeOpen(true)}>
            <SquarePen size={23} />
          </button>
        </span>
      </header>

      <div className="scroll" ref={listRef}>
        <label className="search">
          <Search size={17} />
          <input type="search" placeholder="Пошук" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>

        <HeldBanner me={me} />

        {!q && (
          <div className="folders" role="tablist">
            {FOLDERS.map((f) => {
              const n = unreadBy(f);
              return (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={folder === f.id}
                  className={folder === f.id ? "is-active" : undefined}
                  onClick={() => {
                    setFolder(f.id);
                    savedFolder = f.id;
                  }}
                >
                  {f.label}
                  {n > 0 && <span className="folders__count">{n}</span>}
                </button>
              );
            })}
          </div>
        )}

        {isPending && <div className="skeleton-list">{Array.from({ length: 7 }, (_, i) => <div key={i} className="skeleton-row" />)}</div>}
        {error && <p className="empty-hint">Не вдалося завантажити чати. {error.message}</p>}

        <div className="chat-list">
          {filtered.map((c) => (
            <ChatRow key={c.id} chat={c} meId={me.id} onMenu={setMenuChat} />
          ))}
        </div>

        {q && strangers.length > 0 && (
          <>
            <div className="list-caption">Глобальний пошук</div>
            {strangers.map((u) => (
              <button type="button" key={u.id} className="user-row" onClick={() => openUser(u.id)}>
                <Avatar name={u.displayName} hue={u.avatarHue} size={42} />
                <span className="user-row__body">
                  <span className="user-row__name">{u.displayName}</span>
                  <span className="user-row__sub">@{u.username}</span>
                </span>
              </button>
            ))}
          </>
        )}

        {!isPending && filtered.length === 0 && strangers.length === 0 && (
          <p className="empty-hint">{q ? "Нічого не знайдено" : "Тут поки порожньо"}</p>
        )}
      </div>

      <TabBar />

      <NewChatSheet open={composeOpen} onClose={() => setComposeOpen(false)} />

      <Sheet open={!!menuChat} onClose={() => setMenuChat(null)} label="Дії з чатом">
        {menuChat && (
          <>
            <div className="sheet-group">
              <div className="sheet-preview">
                <span className="sheet-preview__name">{menuChat.title}</span>
              </div>
              <SheetAction
                icon={menuChat.pinned ? <PinOff size={20} /> : <Pin size={20} />}
                onClick={() => {
                  void updateChat(menuChat, { pinned: !menuChat.pinned });
                  setMenuChat(null);
                }}
              >
                {menuChat.pinned ? "Відкріпити" : "Закріпити"}
              </SheetAction>
              <SheetAction
                icon={menuChat.muted ? <Bell size={20} /> : <BellOff size={20} />}
                onClick={() => {
                  void updateChat(menuChat, { muted: !menuChat.muted });
                  setMenuChat(null);
                }}
              >
                {menuChat.muted ? "Увімкнути сповіщення" : "Вимкнути сповіщення"}
              </SheetAction>
            </div>
            <button type="button" className="sheet-cancel" onClick={() => setMenuChat(null)}>
              Скасувати
            </button>
          </>
        )}
      </Sheet>
    </div>
  );
}
