import type { ReactNode } from "react";
import { Link } from "react-router";
import { BellOff, Bot, Pin } from "lucide-react";
import type { ChatSummary } from "../../shared/types";
import { Avatar } from "./Avatar";
import { DoubleTick, MoonTick, SingleTick } from "./Glyphs";
import { formatChatDate } from "../lib/format";
import { usePresence, useTyping } from "../lib/store";
import { useLongPress } from "../lib/useLongPress";

interface Props {
  chat: ChatSummary;
  meId: number;
  onMenu: (chat: ChatSummary) => void;
}

export function ChatRow({ chat, meId, onMenu }: Props) {
  const typing = Object.values(useTyping(chat.id));
  const peer = chat.peer;
  const presence = usePresence(peer?.id, { online: peer?.online ?? false, lastSeenAt: peer?.lastSeenAt ?? null });
  const press = useLongPress(() => onMenu(chat));
  const last = chat.lastMessage;
  const mine = last?.senderId === meId;
  const showOnline = chat.type === "private" && !chat.isSaved && !peer?.isBot && presence.online;

  let preview: ReactNode;
  if (typing.length > 0) {
    preview = (
      <span className="chat-row__typing">
        {chat.type === "group" ? `${typing[0]!.name.split(" ")[0]} друкує` : "друкує"}
        <span className="dots" />
      </span>
    );
  } else if (!last) {
    preview = <span className="chat-row__muted-text">{chat.type === "group" ? "Група створена" : "Немає повідомлень"}</span>;
  } else {
    // Like Telegram: author prefix only in groups; private chats show ticks instead.
    const author = chat.type === "group" ? (mine ? "Ви" : last.senderName.split(" ")[0]) : null;
    preview = (
      <>
        {last.deliverAt !== null && <span className="chat-row__held">🌙 Чекає ранку: </span>}
        {author && <span className="chat-row__author">{author}: </span>}
        {last.text}
      </>
    );
  }

  return (
    <Link to={`/chat/${chat.id}`} className={`chat-row${chat.pinned ? " chat-row--pinned" : ""}`} {...press}>
      <Avatar name={chat.title} hue={chat.avatarHue} saved={chat.isSaved} online={showOnline} />
      <div className="chat-row__body">
        <div className="chat-row__top">
          <span className="chat-row__title">
            {peer?.isBot && <Bot size={16} className="chat-row__bot" aria-label="бот" />}
            <span className="truncate">{chat.title}</span>
            {chat.muted && <BellOff size={14} className="chat-row__mute" aria-label="без звуку" />}
          </span>
          <span className="chat-row__meta">
            {mine && last && !chat.isSaved && (
              <span className="chat-row__ticks">
                {last.deliverAt !== null ? <MoonTick /> : chat.peerReadAt >= last.createdAt ? <DoubleTick /> : <SingleTick />}
              </span>
            )}
            {last && <time>{formatChatDate(last.createdAt)}</time>}
          </span>
        </div>
        <div className="chat-row__bottom">
          <span className="chat-row__preview">{preview}</span>
          {chat.unreadCount > 0 ? (
            <span className={`badge${chat.muted ? " badge--muted" : ""}`}>{chat.unreadCount}</span>
          ) : chat.pinned ? (
            <Pin size={15} className="chat-row__pin" aria-label="закріплено" />
          ) : null}
        </div>
      </div>
    </Link>
  );
}
