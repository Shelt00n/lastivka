import { useCallback, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { Logo } from "./components/Glyphs";
import { ToastHost } from "./components/Toast";
import { useChats, useMe } from "./lib/queries";
import { ApiError } from "./lib/api";
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

/** Server unreachable (redeploy, cold start, offline): keep the session, retry quietly. */
function Offline({ retry }: { retry: () => void }) {
  useEffect(() => {
    const t = setInterval(retry, 4000);
    return () => clearInterval(t);
  }, [retry]);
  return (
    <div className="splash splash--offline">
      <Logo size={72} />
      <p>Немає з'єднання з сервером. Пробуємо ще раз…</p>
      <button type="button" className="link-btn link-btn--bold" onClick={retry}>
        Спробувати зараз
      </button>
    </div>
  );
}

function RequireAuth() {
  const me = useMe();
  const { refetch } = me;
  const retry = useCallback(() => void refetch(), [refetch]);
  if (me.data) return <Authed me={me.data} />;
  if (me.isPending) return <Splash />;
  // Only a real "not logged in" sends you to the login screen — a temporary server error does not.
  const loggedOut = me.data === null || (me.error instanceof ApiError && me.error.status === 401);
  if (loggedOut) return <Navigate to="/login" replace />;
  return <Offline retry={retry} />;
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
