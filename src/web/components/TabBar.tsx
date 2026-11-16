import { NavLink } from "react-router";
import { MessageCircle, Settings } from "lucide-react";
import { useChats } from "../lib/queries";

export function TabBar() {
  const { data: chats } = useChats();
  const unread = chats?.filter((c) => !c.muted).reduce((n, c) => n + c.unreadCount, 0) ?? 0;
  return (
    <nav className="tabbar" aria-label="Розділи">
      <NavLink to="/" end className="tabbar__item">
        <span className="tabbar__icon">
          <MessageCircle size={27} strokeWidth={1.7} />
          {unread > 0 && <span className="badge tabbar__badge">{unread > 99 ? "99+" : unread}</span>}
        </span>
        Чати
      </NavLink>
      <NavLink to="/settings" className="tabbar__item">
        <span className="tabbar__icon">
          <Settings size={27} strokeWidth={1.7} />
        </span>
        Налаштування
      </NavLink>
    </nav>
  );
}
