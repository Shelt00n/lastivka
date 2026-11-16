import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Globe, LogOut, Monitor, Moon, Palette, Shield, Smartphone, Trash2 } from "lucide-react";
import { Sheet } from "../components/Sheet";
import type { Me } from "../../shared/types";
import { formatClock, hhmmToMinutes, isQuietNow, minutesToHHMM, quietEndsAt } from "../../shared/quietHours";
import { LIMITS, updateMeSchema, firstIssue } from "../../shared/validation";
import { Avatar } from "../components/Avatar";
import { TabBar } from "../components/TabBar";
import { Toggle } from "../components/Toggle";
import { toast } from "../components/Toast";
import { api, ApiError, type MePatch } from "../lib/api";
import { qk } from "../lib/queries";
import { describeUserAgent, formatChatDate, formatTime } from "../lib/format";
import { useTheme, type ThemePref } from "../lib/theme";

const detectedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function allTimeZones(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    zones = ["Europe/Kyiv", "Europe/Warsaw", "Europe/London", "America/New_York", "Asia/Tokyo"];
  }
  return [...new Set([current, detectedZone, ...zones])];
}

function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function ProfileCard({ me, save }: { me: Me; save: (p: MePatch) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ displayName: me.displayName, username: me.username, bio: me.bio });

  const submit = async () => {
    const parsed = updateMeSchema.safeParse(form);
    if (!parsed.success) return toast(firstIssue(parsed.error));
    if (await save(parsed.data)) setEditing(false);
  };

  if (!editing) {
    return (
      <section className="card profile-card">
        <Avatar name={me.displayName} hue={me.avatarHue} size={64} />
        <div className="profile-card__body">
          <b>{me.displayName}</b>
          <span>@{me.username}</span>
          {me.bio && <span className="profile-card__bio">{me.bio}</span>}
        </div>
        {!me.isDemo && (
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setForm({ displayName: me.displayName, username: me.username, bio: me.bio });
              setEditing(true);
            }}
          >
            Змінити
          </button>
        )}
      </section>
    );
  }

  return (
    <section className="card edit-card">
      <label className="edit-field">
        <span>Ім'я</span>
        <input value={form.displayName} maxLength={LIMITS.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
      </label>
      <label className="edit-field">
        <span>@username</span>
        <input
          value={form.username}
          autoCapitalize="none"
          spellCheck={false}
          onChange={(e) => setForm({ ...form, username: e.target.value.replace(/^@/, "") })}
        />
      </label>
      <label className="edit-field">
        <span>Про себе</span>
        <input value={form.bio} maxLength={LIMITS.bio} placeholder="Кілька слів про вас" onChange={(e) => setForm({ ...form, bio: e.target.value })} />
      </label>
      <div className="edit-card__actions">
        <button type="button" className="link-btn" onClick={() => setEditing(false)}>
          Скасувати
        </button>
        <button type="button" className="link-btn link-btn--bold" onClick={submit}>
          Зберегти
        </button>
      </div>
    </section>
  );
}

function QuietHoursSection({ me, save }: { me: Me; save: (p: MePatch) => Promise<boolean> }) {
  const now = useNow();
  const q = me.quiet;
  const zones = useMemo(() => allTimeZones(q.timeZone), [q.timeZone]);
  const active = isQuietNow(now, q);
  const endsAt = quietEndsAt(now, q);

  const status = !q.enabled
    ? "Вимкнено: повідомлення приходять одразу в будь-який час."
    : active
      ? `Зараз у вас ${formatClock(now, q.timeZone)} — тихі години до ${minutesToHHMM(q.end)}. Нові повідомлення чекатимуть ранку.`
      : `Зараз у вас ${formatClock(now, q.timeZone)} — повідомлення приходять одразу. Тихі години почнуться о ${minutesToHHMM(q.start)}.`;

  return (
    <>
      <div className="section-title section-title--feature">
        <Moon size={14} /> Тихі години <span className="new-badge">нове</span>
      </div>
      <div className="card">
        <div className="cell cell--row">
          <span className="cell__icon cell__icon--quiet">
            <Moon size={17} />
          </span>
          <span className="cell__grow">Не будити мене вночі</span>
          <Toggle checked={q.enabled} label="Тихі години" onChange={(v) => void save({ quietEnabled: v })} />
        </div>
        {q.enabled && (
          <>
            <label className="cell cell--row">
              <span className="cell__icon cell__icon--quiet">
                <Clock size={17} />
              </span>
              <span className="cell__grow">Початок</span>
              <input
                type="time"
                className="time-input"
                value={minutesToHHMM(q.start)}
                onChange={(e) => {
                  const m = hhmmToMinutes(e.target.value);
                  if (m !== null) void save({ quietStart: m });
                }}
              />
            </label>
            <label className="cell cell--row">
              <span className="cell__icon cell__icon--quiet">
                <Clock size={17} />
              </span>
              <span className="cell__grow">Кінець</span>
              <input
                type="time"
                className="time-input"
                value={minutesToHHMM(q.end)}
                onChange={(e) => {
                  const m = hhmmToMinutes(e.target.value);
                  if (m !== null) void save({ quietEnd: m });
                }}
              />
            </label>
          </>
        )}
        <label className="cell cell--row">
          <span className="cell__icon cell__icon--blue">
            <Globe size={17} />
          </span>
          <span className="cell__grow">Часовий пояс</span>
          <select className="select-input" value={q.timeZone} onChange={(e) => void save({ timeZone: e.target.value })}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
                {z === detectedZone ? " (пристрій)" : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="cell cell--row">
          <span className="cell__icon cell__icon--blue">
            <Clock size={17} />
          </span>
          <span className="cell__grow">Показувати мій місцевий час</span>
          <Toggle checked={me.showLocalTime} label="Показувати місцевий час" onChange={(v) => void save({ showLocalTime: v })} />
        </div>
      </div>
      <p className={`section-footer${active ? " section-footer--quiet" : ""}`}>
        {status}
        {endsAt && me.heldCount > 0 ? ` Вже чекає: ${me.heldCount}.` : ""}
      </p>
      <p className="section-footer">
        Коли у вас тихі години, повідомлення в особисті чати не приходять одразу: сервер притримує їх і доставляє,
        щойно вони закінчаться. Відправник бачить, що ви відпочиваєте, і за потреби може надіслати терміново.
      </p>
    </>
  );
}

function DeleteAccount() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await api.deleteAccount(password);
      qc.clear();
      navigate("/login", { replace: true });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Не вдалося видалити акаунт");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card">
        <button type="button" className="cell cell--button cell--danger" onClick={() => setOpen(true)}>
          <Trash2 size={18} /> Видалити акаунт
        </button>
      </div>
      <Sheet open={open} onClose={() => setOpen(false)} label="Видалення акаунта">
        <div className="sheet-group delete-sheet">
          <b>Видалити акаунт назавжди?</b>
          <span>Ваш профіль, сеанси, повідомлення й особисті чати буде видалено. Це не можна скасувати.</span>
          <input
            type="password"
            className="field"
            placeholder="Пароль для підтвердження"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="button" className="btn-danger" disabled={!password || busy} onClick={confirm}>
            {busy ? "Видаляємо…" : "Видалити назавжди"}
          </button>
        </div>
        <button type="button" className="sheet-cancel" onClick={() => setOpen(false)}>
          Скасувати
        </button>
      </Sheet>
    </>
  );
}

function SessionsSection({ readOnly }: { readOnly: boolean }) {
  const qc = useQueryClient();
  const { data: sessions = [] } = useQuery({ queryKey: qk.sessions, queryFn: api.sessions });
  const others = sessions.filter((s) => !s.current);

  const revoke = async (id?: number) => {
    try {
      if (id) await api.revokeSession(id);
      else await api.revokeOtherSessions();
      toast(id ? "Сеанс завершено" : "Усі інші сеанси завершено");
      void qc.invalidateQueries({ queryKey: qk.sessions });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Не вдалося");
    }
  };

  return (
    <>
      <div className="section-title">
        <Shield size={14} /> Активні сеанси
      </div>
      <div className="card">
        {sessions.map((s) => {
          const mobile = /iPhone|Android|iPad/.test(s.userAgent);
          return (
            <div key={s.id} className="cell cell--row session">
              <span className={`cell__icon ${s.current ? "cell__icon--green" : "cell__icon--gray"}`}>
                {mobile ? <Smartphone size={17} /> : <Monitor size={17} />}
              </span>
              <span className="cell__grow session__body">
                <b>{describeUserAgent(s.userAgent)}</b>
                <span>{s.current ? "Цей пристрій · в мережі" : `Активність: ${formatChatDate(s.lastActiveAt)} ${formatTime(s.lastActiveAt)}`}</span>
              </span>
              {!s.current && !readOnly && (
                <button type="button" className="link-btn link-btn--danger" onClick={() => revoke(s.id)}>
                  Завершити
                </button>
              )}
            </div>
          );
        })}
        {others.length > 0 && !readOnly && (
          <button type="button" className="cell cell--button cell--danger" onClick={() => revoke()}>
            Завершити всі інші сеанси
          </button>
        )}
      </div>
      <p className="section-footer">Сеанс зберігається в захищеному httpOnly-cookie. Завершений сеанс одразу втрачає доступ.</p>
    </>
  );
}

export function SettingsPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [theme, setTheme] = useTheme();

  const save = async (patch: MePatch): Promise<boolean> => {
    const prev = qc.getQueryData<Me>(qk.me);
    if (prev) {
      // Optimistic for snappy toggles.
      qc.setQueryData<Me>(qk.me, {
        ...prev,
        displayName: patch.displayName ?? prev.displayName,
        username: patch.username ?? prev.username,
        bio: patch.bio ?? prev.bio,
        showLocalTime: patch.showLocalTime ?? prev.showLocalTime,
        quiet: {
          enabled: patch.quietEnabled ?? prev.quiet.enabled,
          start: patch.quietStart ?? prev.quiet.start,
          end: patch.quietEnd ?? prev.quiet.end,
          timeZone: patch.timeZone ?? prev.quiet.timeZone,
        },
      });
    }
    try {
      qc.setQueryData(qk.me, await api.updateMe(patch));
      return true;
    } catch (e) {
      if (prev) qc.setQueryData(qk.me, prev);
      toast(e instanceof ApiError ? e.message : "Не вдалося зберегти");
      return false;
    }
  };

  const logout = async () => {
    await api.logout().catch(() => {});
    qc.clear();
    navigate("/login", { replace: true });
  };

  const themes: { id: ThemePref; label: string }[] = [
    { id: "system", label: "Системна" },
    { id: "light", label: "Світла" },
    { id: "dark", label: "Темна" },
  ];

  return (
    <div className="screen screen--grouped">
      <header className="topbar">
        <span className="topbar__side" />
        <h1 className="topbar__title">Налаштування</h1>
        <span className="topbar__side" />
      </header>

      <div className="scroll">
        <ProfileCard me={me} save={save} />
        {me.isDemo && (
          <p className="section-footer">
            Це спільний демо-акаунт для перевірки: профіль і сеанси тут змінювати не можна, а тихі години — можна.
            Щоб спробувати все, зареєструйте власний акаунт.
          </p>
        )}

        <QuietHoursSection me={me} save={save} />

        <div className="section-title">
          <Palette size={14} /> Оформлення
        </div>
        <div className="card card--padded">
          <div className="segmented segmented--inline" role="radiogroup" aria-label="Тема">
            {themes.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={theme === t.id}
                className={theme === t.id ? "is-active" : undefined}
                onClick={() => setTheme(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <SessionsSection readOnly={me.isDemo} />

        <div className="card">
          <button type="button" className="cell cell--button cell--danger" onClick={logout}>
            <LogOut size={18} /> Вийти
          </button>
        </div>

        {!me.isDemo && <DeleteAccount />}

        <p className="app-footer">Ластівка 1.0 · мобільна веб-версія у стилі Telegram</p>
      </div>

      <TabBar />
    </div>
  );
}
