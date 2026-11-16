import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff } from "lucide-react";
import { Logo } from "../components/Glyphs";
import { api, ApiError } from "../lib/api";
import { qk, useMe } from "../lib/queries";
import { firstIssue, loginSchema, registerSchema } from "../../shared/validation";

const DEMO = { username: "demo", password: "lastivka-demo" };

export function LoginPage() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (me.data) return <Navigate to="/" replace />;

  const submit = async (e?: FormEvent, override?: { username: string; password: string }) => {
    e?.preventDefault();
    setError(null);
    const creds = override ?? { username: username.replace(/^@/, ""), password };
    const isRegister = mode === "register" && !override;
    const parsed = isRegister
      ? registerSchema.safeParse({ ...creds, displayName })
      : loginSchema.safeParse(creds);
    if (!parsed.success) return setError(firstIssue(parsed.error));

    setBusy(true);
    try {
      const user = isRegister
        ? await api.register({
            username: creds.username,
            displayName,
            password: creds.password,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          })
        : await api.login(creds.username, creds.password);
      qc.clear();
      qc.setQueryData(qk.me, user);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Щось пішло не так");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login page">
      <div className="login__hero">
        <Logo size={104} />
        <h1>Ластівка</h1>
        <p>Месенджер у стилі Telegram, який не будить уночі 🌙</p>
      </div>

      <div className="segmented" role="tablist">
        {(["login", "register"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className={mode === m ? "is-active" : undefined}
            onClick={() => {
              setMode(m);
              setError(null);
            }}
          >
            {m === "login" ? "Вхід" : "Реєстрація"}
          </button>
        ))}
      </div>

      <form className="login__form" onSubmit={submit} noValidate>
        <div className="group">
          <label className="group-field">
            <span className="group-field__prefix">@</span>
            <input
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="ім'я користувача"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          {mode === "register" && (
            <label className="group-field">
              <input
                autoComplete="name"
                placeholder="Ваше ім'я (видно іншим)"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </label>
          )}
          <label className="group-field">
            <input
              type={showPassword ? "text" : "password"}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              placeholder={mode === "login" ? "Пароль" : "Пароль (від 8 символів)"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              className="icon-btn"
              aria-label={showPassword ? "Сховати пароль" : "Показати пароль"}
              onClick={() => setShowPassword((s) => !s)}
            >
              {showPassword ? <EyeOff size={19} /> : <Eye size={19} />}
            </button>
          </label>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "Зачекайте…" : mode === "login" ? "Увійти" : "Створити акаунт"}
        </button>
      </form>

      <div className="demo-card">
        <b>Демо-доступ для перевірки</b>
        <span>
          <code>demo</code> або <code>demo2</code> · пароль <code>{DEMO.password}</code>
        </span>
        <button type="button" className="link-btn link-btn--bold" disabled={busy} onClick={() => submit(undefined, DEMO)}>
          Увійти як демо
        </button>
      </div>
    </main>
  );
}
