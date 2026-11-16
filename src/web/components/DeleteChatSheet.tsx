import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut, Trash2, Users } from "lucide-react";
import type { ChatSummary } from "../../shared/types";
import { Sheet, SheetAction } from "./Sheet";
import { toast } from "./Toast";
import { api, ApiError } from "../lib/api";
import { forgetChat } from "../lib/queries";

interface Props {
  chat: ChatSummary | null;
  /** Group owner: may delete the group for everyone (known on the info page). */
  isOwner?: boolean;
  /** Shared demo accounts can only delete for themselves. */
  isDemo: boolean;
  onClose: () => void;
  onDeleted?: () => void;
}

/** Telegram-style delete: for me / for both, leave a group, clear Saved Messages. */
export function DeleteChatSheet({ chat, isOwner, isDemo, onClose, onDeleted }: Props) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  if (!chat) return null;

  const run = async (forEveryone: boolean, done: string) => {
    setBusy(true);
    try {
      await api.deleteChat(chat.id, forEveryone);
      forgetChat(qc, chat.id);
      toast(done);
      onClose();
      onDeleted?.();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Не вдалося видалити чат");
    } finally {
      setBusy(false);
    }
  };

  const firstName = chat.peer?.displayName.split(" ")[0] ?? "";
  const isGroup = chat.type === "group";
  const isBot = !!chat.peer?.isBot;

  let title: string;
  let hint: string;
  if (chat.isSaved) {
    title = "Очистити «Збережене»?";
    hint = "Усі ваші нотатки буде видалено назавжди.";
  } else if (isGroup) {
    title = `Покинути «${chat.title}»?`;
    hint = isOwner && !isDemo ? "Ви власник: можете також видалити групу для всіх учасників." : "Ви більше не бачитимете цю групу.";
  } else {
    title = `Видалити чат «${chat.title}»?`;
    hint = isBot
      ? "Історію переписки з ботом буде видалено."
      : isDemo
        ? "У спільному демо-акаунті чат видаляється лише для вас — у співрозмовника він залишиться."
        : "«Лише для мене» — у співрозмовника чат залишиться. «Для обох» — зникне в усіх.";
  }

  return (
    <Sheet open onClose={onClose} label="Видалення чату">
      <div className="sheet-group">
        <div className="sheet-preview">
          <span className="sheet-preview__name">{title}</span>
          <span className="sheet-preview__text">{hint}</span>
        </div>
        {chat.isSaved && (
          <SheetAction danger icon={<Trash2 size={20} />} onClick={() => !busy && run(false, "«Збережене» очищено")}>
            Очистити
          </SheetAction>
        )}
        {isGroup && (
          <SheetAction danger icon={<LogOut size={20} />} onClick={() => !busy && run(false, "Ви покинули групу")}>
            Покинути групу
          </SheetAction>
        )}
        {isGroup && isOwner && !isDemo && (
          <SheetAction danger icon={<Users size={20} />} onClick={() => !busy && run(true, "Групу видалено")}>
            Видалити групу для всіх
          </SheetAction>
        )}
        {!chat.isSaved && !isGroup && (
          <SheetAction danger icon={<Trash2 size={20} />} onClick={() => !busy && run(false, "Чат видалено")}>
            {isBot ? "Видалити чат" : "Видалити лише для мене"}
          </SheetAction>
        )}
        {!chat.isSaved && !isGroup && !isBot && !isDemo && (
          <SheetAction danger icon={<Users size={20} />} onClick={() => !busy && run(true, "Чат видалено для обох")}>
            Видалити для мене і {firstName}
          </SheetAction>
        )}
      </div>
      <button type="button" className="sheet-cancel" onClick={onClose}>
        Скасувати
      </button>
    </Sheet>
  );
}
