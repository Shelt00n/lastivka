import { useState } from "react";
import { Copy, Pencil, Reply, RotateCw, Send, Trash2 } from "lucide-react";
import { Sheet, SheetAction } from "./Sheet";
import { REACTIONS } from "../../shared/validation";
import type { ClientMessage } from "../lib/messages";
import { formatWhen } from "../lib/format";

interface Props {
  message: ClientMessage | null;
  meId: number;
  onClose: () => void;
  onReply: (m: ClientMessage) => void;
  onEdit: (m: ClientMessage) => void;
  onDelete: (m: ClientMessage) => void;
  onDeliverNow: (m: ClientMessage) => void;
  onReact: (m: ClientMessage, emoji: string | null) => void;
  onCopy: (m: ClientMessage) => void;
  onRetry: (m: ClientMessage) => void;
}

export function MessageMenu(props: Props) {
  const { message, meId, onClose, onReply, onEdit, onDelete, onDeliverNow, onReact, onCopy, onRetry } = props;
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!message) return null;
  const mine = message.senderId === meId;
  const held = message.deliverAt !== null;
  const real = message.id > 0 && !message.status;
  const myReaction = message.reactions.find((r) => r.mine)?.emoji ?? null;

  const act = (fn: (m: ClientMessage) => void) => () => {
    fn(message);
    setConfirmDelete(false);
    onClose();
  };

  return (
    <Sheet
      open
      label="Дії з повідомленням"
      onClose={() => {
        setConfirmDelete(false);
        onClose();
      }}
    >
      {real && !held && (
        <div className="reaction-picker" role="group" aria-label="Реакції">
          {REACTIONS.map((emoji) => (
            <button
              type="button"
              key={emoji}
              className={emoji === myReaction ? "is-active" : undefined}
              onClick={act((m) => onReact(m, emoji === myReaction ? null : emoji))}
              aria-label={`Реакція ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      <div className="sheet-group">
        <div className="sheet-preview">
          <span className="sheet-preview__name">{mine ? "Ви" : message.senderName}</span>
          <span className="sheet-preview__text">{message.text}</span>
          {held && <span className="sheet-preview__held">🌙 Буде доставлено {formatWhen(message.deliverAt!)}</span>}
        </div>
        {real && !held && <SheetAction icon={<Reply size={20} />} onClick={act(onReply)}>Відповісти</SheetAction>}
        {message.status === "failed" && (
          <SheetAction icon={<RotateCw size={20} />} onClick={act(onRetry)}>Надіслати ще раз</SheetAction>
        )}
        <SheetAction icon={<Copy size={20} />} onClick={act(onCopy)}>Копіювати</SheetAction>
        {message.status === "failed" && (
          <SheetAction danger icon={<Trash2 size={20} />} onClick={act(onDelete)}>Видалити</SheetAction>
        )}
        {real && mine && held && (
          <SheetAction icon={<Send size={20} />} onClick={act(onDeliverNow)}>Надіслати зараз</SheetAction>
        )}
        {real && mine && <SheetAction icon={<Pencil size={20} />} onClick={act(onEdit)}>Редагувати</SheetAction>}
        {real && mine &&
          (confirmDelete ? (
            <SheetAction danger icon={<Trash2 size={20} />} onClick={act(onDelete)}>
              {held ? "Так, скасувати надсилання" : "Так, видалити для всіх"}
            </SheetAction>
          ) : (
            <SheetAction danger icon={<Trash2 size={20} />} onClick={() => setConfirmDelete(true)}>
              {held ? "Скасувати надсилання" : "Видалити"}
            </SheetAction>
          ))}
      </div>
      <button type="button" className="sheet-cancel" onClick={onClose}>
        Скасувати
      </button>
    </Sheet>
  );
}
