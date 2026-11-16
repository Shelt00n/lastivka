import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { ApiError, setUnauthorizedHandler } from "./lib/api";
import { qk } from "./lib/queries";
import { applyTheme } from "./lib/theme";
import "./styles/base.css";
import "./styles/chats.css";
import "./styles/chat.css";
import "./styles/settings.css";

applyTheme();
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

// Session ended elsewhere (logout, terminated from another device) → back to login.
setUnauthorizedHandler(() => {
  queryClient.setQueryData(qk.me, null);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
