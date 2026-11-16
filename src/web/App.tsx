import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { Logo } from "./components/Glyphs";
import { ToastHost } from "./components/Toast";
import { useChats, useMe } from "./lib/queries";
import { useRealtime } from "./lib/realtime";
import type { Me } from "../shared/types";
import { LoginPage } from "./pages/LoginPage";
import { ChatsPage } from "./pages/ChatsPage";
import { ChatPage } from "./pages/ChatPage";
import { ChatInfoPage } from "./pages/ChatInfoPage";
import { SettingsPage } from "./pages/SettingsPage";

function Splash() {
  return (
    <div className="splash">
      <Logo size={88} />
    </div>
  );
}

/** Unread counter in the browser tab title. */
function useDocumentTitle() {
  const { data } = useChats();
  const unread = data?.filter((c) => !c.muted).reduce((n, c) => n + c.unreadCount, 0) ?? 0;
  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) Ластівка` : "Ластівка";
  }, [unread]);
}

function Authed({ me }: { me: Me }) {
  useRealtime(me.id);
  useDocumentTitle();
  const location = useLocation();
  return (
    // Keyed wrapper → a light slide-in animation on every page change, like iOS navigation.
    <div className="page" key={location.pathname}>
      <Routes location={location}>
        <Route index element={<ChatsPage me={me} />} />
        <Route path="settings" element={<SettingsPage me={me} />} />
        <Route path="chat/:id" element={<ChatPage me={me} key={location.pathname} />} />
        <Route path="chat/:id/info" element={<ChatInfoPage me={me} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}

function RequireAuth() {
  const me = useMe();
  if (me.isPending) return <Splash />;
  if (!me.data) return <Navigate to="/login" replace />;
  return <Authed me={me.data} />;
}

export function App() {
  return (
    <div className="app-frame" id="app-frame">
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/*" element={<RequireAuth />} />
      </Routes>
      <ToastHost />
    </div>
  );
}
