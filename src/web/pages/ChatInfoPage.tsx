import { Link, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, ChevronLeft, MessageCircle, Moon, Pin } from "lucide-react";
import type { ChatDetail, Me, UserPublic } from "../../shared/types";
import { formatClock, minutesToHHMM } from "../../shared/quietHours";
import { Avatar } from "../components/Avatar";
import { Toggle } from "../components/Toggle";
import { toast } from "../components/Toast";
import { api, ApiError } from "../lib/api";
import { patchChat, qk, useChat } from "../lib/queries";
import { usePresence } from "../lib/store";
import { formatLastSeen, formatMembers, formatWhen } from "../lib/format";

const BOT_EXAMPLES: Record<string, string[]> = {
  pogoda_bot: ["Київ", "погода у Львові", "Tokyo"],
  nbu_rates_bot: ["Курси", "USD", "100 євро", "1000 грн в PLN"],
  wiki_bot: ["Ластівка", "Тарас Шевченко", "Карпати"],
};

function QuietInfo({ user }: { user: UserPublic }) {
  const now = Date.now();
  const q = user.quiet;
  return (
    <>
      {user.timeZone && (
        <div className="cell">
          <span className="cell__label">місцевий час</span>
          <span className="cell__value">
            {formatClock(now, user.timeZone)} · {user.timeZone.split("/").pop()?.replace(/_/g, " ")}
          </span>
        </div>
      )}
      {q && (
        <div className="cell cell--quiet">
          <span className="cell__label cell__label--icon">
            <Moon size={13} /> тихі години
          </span>
          <span className="cell__value">
            {q.start !== null && q.end !== null ? `${minutesToHHMM(q.start)}–${minutesToHHMM(q.end)}` : "увімкнено"}
            {q.active && q.endsAt ? ` · зараз відпочиває, повідомлення прийдуть ${formatWhen(q.endsAt)} за вашим часом` : ""}
          </span>
        </div>
      )}
    </>
  );
}

function MemberRow({ user, me, onOpen }: { user: UserPublic; me: Me; onOpen: (u: UserPublic) => void }) {
  const presence = usePresence(user.id, { online: user.online, lastSeenAt: user.lastSeenAt });
  return (
    <button type="button" className="user-row" onClick={() => onOpen(user)} disabled={user.id === me.id}>
      <Avatar name={user.displayName} hue={user.avatarHue} size={40} />
      <span className="user-row__body">
        <span className="user-row__name">{user.id === me.id ? `${user.displayName} (ви)` : user.displayName}</span>
        <span className={`user-row__sub${presence.online ? " user-row__sub--online" : ""}`}>
          {user.isBot ? "бот" : formatLastSeen(presence.online, presence.lastSeenAt)}
        </span>
      </span>
    </button>
  );
}

export function ChatInfoPage({ me }: { me: Me }) {
  const chatId = Number(useParams().id);
  const { data: chat, error } = useChat(chatId);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const peer = chat?.peer;
  const presence = usePresence(peer?.id, { online: peer?.online ?? false, lastSeenAt: peer?.lastSeenAt ?? null });

  const update = async (patch: { pinned?: boolean; muted?: boolean }) => {
    patchChat(qc, chatId, () => patch);
    try {
      qc.setQueryData<ChatDetail>(qk.chat(chatId), await api.updateChat(chatId, patch));
      void qc.invalidateQueries({ queryKey: qk.chats });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Не вдалося змінити");
      void qc.invalidateQueries({ queryKey: qk.chat(chatId) });
    }
  };

  const openMember = async (user: UserPublic) => {
    try {
      const c = await api.openPrivate(user.id);
      qc.setQueryData(qk.chat(c.id), c);
      navigate(`/chat/${c.id}/info`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Не вдалося відкрити профіль");
    }
  };

  const subtitle = !chat
    ? ""
    : chat.isSaved
      ? "нотатки для себе"
      : chat.type === "group"
        ? formatMembers(chat.memberCount)
        : peer?.isBot
          ? "бот"
          : formatLastSeen(presence.online, presence.lastSeenAt);

  return (
    <div className="screen screen--grouped">
      <header className="topbar topbar--transparent">
        <Link to={`/chat/${chatId}`} className="back-btn">
          <ChevronLeft size={28} />
          Назад
        </Link>
      </header>

      <div className="scroll">
        {error && <p className="empty-hint">Чат не знайдено.</p>}
        {chat && (
          <>
            <section className="profile-hero">
              <Avatar name={chat.title} hue={chat.avatarHue} saved={chat.isSaved} size={104} />
              <h1>{chat.title}</h1>
              <p className={presence.online && chat.type === "private" && !peer?.isBot ? "is-online" : undefined}>{subtitle}</p>
            </section>

            <div className="action-tiles">
              <Link to={`/chat/${chatId}`} className="action-tile">
                <MessageCircle size={22} />
                написати
              </Link>
              {!chat.isSaved && (
                <button type="button" className="action-tile" onClick={() => update({ muted: !chat.muted })}>
                  <Bell size={22} />
                  {chat.muted ? "увімкнути звук" : "без звуку"}
                </button>
              )}
              <button type="button" className="action-tile" onClick={() => update({ pinned: !chat.pinned })}>
                <Pin size={22} />
                {chat.pinned ? "відкріпити" : "закріпити"}
              </button>
            </div>

            {chat.type === "private" && peer && !chat.isSaved && (
              <div className="card">
                <div className="cell">
                  <span className="cell__label">ім'я користувача</span>
                  <span className="cell__value cell__value--accent">@{peer.username}</span>
                </div>
                {peer.bio && (
                  <div className="cell">
                    <span className="cell__label">{peer.isBot ? "опис" : "про себе"}</span>
                    <span className="cell__value">{peer.bio}</span>
                  </div>
                )}
                {!peer.isBot && <QuietInfo user={peer} />}
              </div>
            )}

            {peer?.isBot && BOT_EXAMPLES[peer.username] && (
              <>
                <div className="section-title">Спробуйте написати</div>
                <div className="card card--chips">
                  {BOT_EXAMPLES[peer.username]!.map((ex) => (
                    <span key={ex} className="chip chip--static">
                      {ex}
                    </span>
                  ))}
                </div>
                <p className="section-footer">Бот отримує дані із зовнішнього API на сервері — ваш IP та сесія не передаються стороннім сервісам.</p>
              </>
            )}

            {chat.isSaved && (
              <p className="section-footer">Пересилайте сюди важливе, пишіть нотатки та ідеї. Ці повідомлення бачите лише ви.</p>
            )}

            {chat.type === "group" && (
              <>
                <div className="section-title">{formatMembers(chat.memberCount)}</div>
                <div className="card">
                  {chat.members.map((u) => (
                    <MemberRow key={u.id} user={u} me={me} onOpen={openMember} />
                  ))}
                </div>
              </>
            )}

            {!chat.isSaved && (
              <div className="card">
                <div className="cell cell--row">
                  <span className="cell__grow">Сповіщення</span>
                  <Toggle checked={!chat.muted} label="Сповіщення" onChange={(v) => update({ muted: !v })} />
                </div>
                <div className="cell cell--row">
                  <span className="cell__grow">Закріпити в списку</span>
                  <Toggle checked={chat.pinned} label="Закріпити" onChange={(v) => update({ pinned: v })} />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
