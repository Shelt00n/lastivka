import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Check, Moon, Pencil, Reply, X, Zap } from "lucide-react";
import type { ChatDetail, DeliveryMode } from "../../shared/types";
import { formatClock, minutesToHHMM, timeZoneOffsetMs } from "../../shared/quietHours";
import { LIMITS } from "../../shared/validation";
import { formatWhen } from "../lib/format";
import type { ClientMessage } from "../lib/messages";
import { api } from "../lib/api";

interface Props {
  chat: ChatDetail;
  replyTo: ClientMessage | null;
  editing: ClientMessage | null;
  botButtons: string[] | null;
  onCancel: () => void;
  onSend: (text: string, delivery: DeliveryMode) => void;
  onSaveEdit: (message: ClientMessage, text: string) => void;
}

const finePointer = () => window.matchMedia("(pointer: fine)").matches;
const myTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Is the other person in quiet hours right now? (server re-checks on send) */
export function useQuietPeer(chat: ChatDetail) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const peer = chat.peer;
  if (chat.type !== "private" || chat.isSaved || !peer || peer.isBot) return null;
  const q = peer.quiet;
  if (!q?.active || !q.endsAt || q.endsAt <= now) return null;
  return { peer, endsAt: q.endsAt, now };
}

function QuietBanner({ chat, urgent, onToggle }: { chat: ChatDetail; urgent: boolean; onToggle: () => void }) {
  const quiet = useQuietPeer(chat);
  if (!quiet) return null;
  const { peer, endsAt, now } = quiet;
  const firstName = peer.displayName.split(" ")[0];
  const sameZone = !peer.timeZone || timeZoneOffsetMs(now, peer.timeZone) === timeZoneOffsetMs(now, myTimeZone);
  const peerEnd = !sameZone && peer.quiet?.end != null ? minutesToHHMM(peer.quiet.end) : null;
  return (
    <div className={`quiet-banner${urgent ? " quiet-banner--urgent" : ""}`} role="status">
      <span className="quiet-banner__icon">{urgent ? <Zap size={18} /> : <Moon size={18} />}</span>
      <span className="quiet-banner__text">
        <b>
          {firstName} відпочиває{peer.timeZone ? ` · там ${formatClock(now, peer.timeZone)}` : ""}
        </b>
        <span>
          {urgent
            ? "Надішлеться одразу, зі сповіщенням"
            : `Доставимо ${formatWhen(endsAt, now)}${peerEnd ? ` (там ${peerEnd})` : ""}`}
        </span>
      </span>
      <button type="button" className="quiet-banner__toggle" onClick={onToggle}>
        {urgent ? "Вранці" : "Терміново"}
      </button>
    </div>
  );
}

export function Composer({ chat, replyTo, editing, botButtons, onCancel, onSend, onSaveEdit }: Props) {
  const [text, setText] = useState("");
  const [urgent, setUrgent] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);
  const quiet = useQuietPeer(chat);
  const willHold = !!quiet && !urgent && !editing;

  // Entering edit mode pre-fills the text; reply mode focuses the input.
  useEffect(() => {
    if (editing) setText(editing.text);
    if (editing || replyTo) area.current?.focus();
  }, [editing, replyTo]);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    if (editing) {
      if (value !== editing.text) onSaveEdit(editing, value);
      else onCancel();
    } else {
      onSend(value, willHold ? "gentle" : "now");
      setUrgent(false);
    }
    setText("");
  };

  const onChange = (value: string) => {
    setText(value);
    const now = Date.now();
    if (value && !editing && now - lastTyping.current > 4000 && !chat.peer?.isBot && !chat.isSaved) {
      lastTyping.current = now;
      void api.typing(chat.id).catch(() => {});
    }
  };

  const context = editing ?? replyTo;

  return (
    <div className="composer">
      {!editing && <QuietBanner chat={chat} urgent={urgent} onToggle={() => setUrgent((u) => !u)} />}
      {context && (
        <div className="composer__context">
          {editing ? <Pencil size={20} /> : <Reply size={20} />}
          <div className="composer__context-body">
            <b>{editing ? "Редагування" : `Відповідь: ${replyTo!.senderName}`}</b>
            <span className="truncate">{context.text}</span>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Скасувати"
            onClick={() => {
              if (editing) setText("");
              onCancel();
            }}
          >
            <X size={20} />
          </button>
        </div>
      )}
      {botButtons && botButtons.length > 0 && !editing && (
        <div className="bot-keyboard">
          {botButtons.map((b) => (
            <button type="button" key={b} onClick={() => onSend(b, "now")}>
              {b}
            </button>
          ))}
        </div>
      )}
      <form
        className="composer__row"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={area}
          rows={1}
          value={text}
          maxLength={LIMITS.messageText}
          placeholder={willHold ? "Повідомлення (прийде вранці)" : "Повідомлення"}
          aria-label="Текст повідомлення"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && finePointer()) {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape" && context) onCancel();
          }}
        />
        <button
          type="submit"
          className={`send-btn${willHold ? " send-btn--quiet" : ""}`}
          disabled={!text.trim()}
          aria-label={editing ? "Зберегти" : willHold ? "Надіслати вранці" : "Надіслати"}
        >
          {editing ? <Check size={20} strokeWidth={2.6} /> : willHold ? <Moon size={18} strokeWidth={2.4} /> : <ArrowUp size={20} strokeWidth={2.6} />}
        </button>
      </form>
    </div>
  );
}
