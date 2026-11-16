import { useDeferredValue, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Search, Users } from "lucide-react";
import { Sheet } from "./Sheet";
import { Avatar } from "./Avatar";
import { toast } from "./Toast";
import { api, ApiError } from "../lib/api";
import { qk } from "../lib/queries";
import { formatLastSeen } from "../lib/format";
import { LIMITS } from "../../shared/validation";
import type { UserPublic } from "../../shared/types";

export function NewChatSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<"chat" | "group">("chat");
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<UserPublic[]>([]);
  const [busy, setBusy] = useState(false);
  const deferred = useDeferredValue(query.trim());
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: users = [], isFetching } = useQuery({
    queryKey: qk.search(deferred),
    queryFn: () => api.searchUsers(deferred),
    enabled: open,
    staleTime: 10_000,
  });
  const list = mode === "group" ? users.filter((u) => !u.isBot) : users;

  const close = () => {
    setMode("chat");
    setQuery("");
    setTitle("");
    setSelected([]);
    onClose();
  };

  const openChat = async (user: UserPublic) => {
    try {
      const chat = await api.openPrivate(user.id);
      qc.setQueryData(qk.chat(chat.id), chat);
      close();
      navigate(`/chat/${chat.id}`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Не вдалося відкрити чат");
    }
  };

  const toggle = (user: UserPublic) =>
    setSelected((s) => (s.some((u) => u.id === user.id) ? s.filter((u) => u.id !== user.id) : [...s, user]));

  const createGroup = async () => {
    setBusy(true);
    try {
      const chat = await api.createGroup(title.trim(), selected.map((u) => u.id));
      void qc.invalidateQueries({ queryKey: qk.chats });
      close();
      navigate(`/chat/${chat.id}`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Не вдалося створити групу");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={close} variant="full" label={mode === "group" ? "Нова група" : "Нове повідомлення"}>
      <header className="modal-header">
        <button type="button" className="link-btn" onClick={mode === "group" ? () => setMode("chat") : close}>
          {mode === "group" ? "Назад" : "Скасувати"}
        </button>
        <h2>{mode === "group" ? "Нова група" : "Нове повідомлення"}</h2>
        {mode === "group" ? (
          <button
            type="button"
            className="link-btn link-btn--bold"
            disabled={busy || !title.trim() || selected.length === 0}
            onClick={createGroup}
          >
            Створити
          </button>
        ) : (
          <span className="modal-header__spacer" />
        )}
      </header>

      {mode === "group" && (
        <div className="group-form">
          <input
            className="field"
            placeholder="Назва групи"
            value={title}
            maxLength={LIMITS.groupTitle}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
          {selected.length > 0 && (
            <div className="chips">
              {selected.map((u) => (
                <button type="button" key={u.id} className="chip" onClick={() => toggle(u)}>
                  {u.displayName} ×
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <label className="search">
        <Search size={17} />
        <input
          type="search"
          placeholder="Пошук за іменем або @username"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus={mode === "chat"}
        />
      </label>

      <div className="modal-list">
        {mode === "chat" && !deferred && (
          <button type="button" className="list-action" onClick={() => setMode("group")}>
            <span className="list-action__icon">
              <Users size={22} />
            </span>
            Нова група
          </button>
        )}
        <div className="list-caption">{deferred ? "Результати пошуку" : "Контакти та боти"}</div>
        {list.map((u) => {
          const checked = selected.some((s) => s.id === u.id);
          return (
            <button
              type="button"
              key={u.id}
              className="user-row"
              onClick={() => (mode === "group" ? toggle(u) : openChat(u))}
            >
              <Avatar name={u.displayName} hue={u.avatarHue} size={42} />
              <span className="user-row__body">
                <span className="user-row__name">{u.displayName}</span>
                <span className="user-row__sub">
                  {u.isBot ? `@${u.username} · бот` : `@${u.username} · ${formatLastSeen(u.online, u.lastSeenAt)}`}
                </span>
              </span>
              {mode === "group" && <span className={`checkbox${checked ? " checkbox--on" : ""}`}>{checked && <Check size={14} strokeWidth={3} />}</span>}
            </button>
          );
        })}
        {!isFetching && list.length === 0 && <p className="empty-hint">Нікого не знайдено</p>}
      </div>
    </Sheet>
  );
}
