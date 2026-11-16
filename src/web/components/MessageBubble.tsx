import { memo, type CSSProperties } from "react";
import { CircleAlert } from "lucide-react";
import { Avatar } from "./Avatar";
import { ClockTick, DoubleTick, MoonTick, SingleTick, Tail } from "./Glyphs";
import { formatTime, formatWhen } from "../lib/format";
import { isEmojiOnly, linkify, type ClientMessage } from "../lib/messages";
import { useLongPress } from "../lib/useLongPress";

interface Props {
  message: ClientMessage;
  mine: boolean;
  first: boolean;
  last: boolean;
  read: boolean;
  showSender: boolean;
  onMenu: (m: ClientMessage) => void;
  onQuickReact: (m: ClientMessage) => void;
  onReplyClick: (id: number) => void;
  onToggleReaction: (m: ClientMessage, emoji: string) => void;
}

function Status({ message, mine, read }: { message: ClientMessage; mine: boolean; read: boolean }) {
  if (!mine) return null;
  if (message.status === "failed") return <CircleAlert size={13} className="tick tick--failed" aria-label="Не надіслано" />;
  if (message.status === "sending") return <ClockTick />;
  if (message.deliverAt !== null) return <MoonTick />;
  return read ? <DoubleTick /> : <SingleTick />;
}

function Meta({ message, mine, read, ghost }: { message: ClientMessage; mine: boolean; read: boolean; ghost?: boolean }) {
  const time = message.deliverAt !== null ? formatWhen(message.deliverAt) : formatTime(message.createdAt);
  return (
    <span className={`meta${ghost ? " meta--ghost" : ""}`} aria-hidden={ghost}>
      {message.editedAt && <span className="meta__edited">ред.</span>}
      <time>{time}</time>
      <Status message={message} mine={mine} read={read} />
    </span>
  );
}

export const MessageBubble = memo(function MessageBubble(props: Props) {
  const { message, mine, first, last, read, showSender, onMenu, onQuickReact, onReplyClick, onToggleReaction } = props;
  const press = useLongPress(() => onMenu(message));
  const held = message.deliverAt !== null;
  const big = isEmojiOnly(message.text) && !message.replyTo && message.reactions.length === 0;
  const hasReactions = message.reactions.length > 0;

  const cls = [
    "msg",
    mine ? "msg--out" : "msg--in",
    first && "msg--first",
    last && "msg--last",
    held && "msg--held",
    big && "msg--big",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls} id={`msg-${message.id}`}>
      {showSender && !mine && (
        <span className="msg__avatar">{last && <Avatar name={message.senderName} hue={message.senderHue} size={34} />}</span>
      )}
      <div
        className="bubble"
        {...press}
        onDoubleClick={() => !held && message.id > 0 && onQuickReact(message)}
        style={{ "--h": message.senderHue } as CSSProperties}
      >
        {showSender && !mine && first && !big && <div className="bubble__sender">{message.senderName}</div>}
        {message.replyTo && (
          <button type="button" className="bubble__reply" onClick={() => onReplyClick(message.replyTo!.id)}>
            <span className="bubble__reply-name">{message.replyTo.senderName}</span>
            <span className="bubble__reply-text">{message.replyTo.text}</span>
          </button>
        )}
        <div className="bubble__text">
          {linkify(message.text).map((part, i) =>
            part.type === "link" ? (
              <a key={i} href={part.href} target="_blank" rel="noopener noreferrer nofollow" onClick={(e) => e.stopPropagation()}>
                {part.value}
              </a>
            ) : (
              <span key={i}>{part.value}</span>
            ),
          )}
          {!hasReactions && <Meta message={message} mine={mine} read={read} ghost />}
        </div>
        {hasReactions ? (
          <div className="bubble__footer">
            <div className="reactions">
              {message.reactions.map((r) => (
                <button
                  type="button"
                  key={r.emoji}
                  className={`reaction${r.mine ? " reaction--mine" : ""}`}
                  onClick={() => onToggleReaction(message, r.emoji)}
                >
                  {r.emoji}
                  {r.count > 1 && <span>{r.count}</span>}
                </button>
              ))}
            </div>
            <Meta message={message} mine={mine} read={read} />
          </div>
        ) : (
          <Meta message={message} mine={mine} read={read} />
        )}
        {last && !big && <Tail />}
      </div>
    </div>
  );
});
