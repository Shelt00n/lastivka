import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { z } from "zod";

import { HttpError, notFound, type AppContext } from "./context";
import { RateLimiter } from "./security";
import {
  chatSettingsSchema,
  createGroupSchema,
  createPrivateSchema,
  deleteAccountSchema,
  deleteChatSchema,
  editMessageSchema,
  firstIssue,
  loginSchema,
  reactionSchema,
  readSchema,
  registerSchema,
  sendMessageSchema,
  updateMeSchema,
} from "../shared/validation";
import * as auth from "./services/auth";
import { contactIds, getUser, publicUsersFor, searchUsers, toMe, type UserRow } from "./services/users";
import { createGroup, deleteChat, getChat, listChats, openPrivateChat, updateChatSettings } from "./services/chats";
import { blockUser, unblockUser } from "./services/blocks";
import * as messages from "./services/messages";
import { MAX_STREAMS_PER_USER } from "./services/hub";
import { onboardUser } from "./seed";

type Env = { Variables: { user: UserRow; sessionId: number } };

export interface AppOptions {
  secureCookies: boolean;
  /** Behind a reverse proxy (Render, Fly): read the client IP from proxy headers. */
  trustProxy: boolean;
  /** Extra allowed Origin for state-changing requests (e.g. https://lastivka.example.com). */
  publicOrigin?: string;
  /** Interval for re-checking that an SSE stream's session is still valid. */
  ssePingMs?: number;
}

export function createApp(ctx: AppContext, opts: AppOptions) {
  const cookieName = opts.secureCookies ? "__Host-lst_sid" : "lst_sid";
  const MIN = 60_000;
  const limits = {
    loginPerIpUser: new RateLimiter(10, 5 * MIN, ctx.now),
    loginPerIp: new RateLimiter(50, 5 * MIN, ctx.now),
    // Independent of IP (which a client may try to spoof): caps guessing against one account.
    loginPerAccount: new RateLimiter(100, 15 * MIN, ctx.now),
    registerPerIp: new RateLimiter(10, 60 * MIN, ctx.now),
    registerGlobal: new RateLimiter(200, 60 * MIN, ctx.now),
    send: new RateLimiter(30, 10_000, ctx.now),
    writes: new RateLimiter(120, MIN, ctx.now),
    typing: new RateLimiter(20, 10_000, ctx.now),
    groups: new RateLimiter(10, 60 * MIN, ctx.now),
  };

  const app = new Hono<Env>();

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: opts.secureCookies ? "max-age=15552000; includeSubDomains" : false,
      referrerPolicy: "strict-origin-when-cross-origin",
      permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
    }),
  );

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "Внутрішня помилка сервера" }, 500);
  });

  // ---------- helpers ----------

  const clientIp = (c: Context): string => {
    if (opts.trustProxy) {
      // Edge-set headers first (cannot be supplied by the client), then the left-most X-Forwarded-For.
      const edge = c.req.header("cf-connecting-ip") ?? c.req.header("true-client-ip");
      if (edge) return edge.trim();
      const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      if (fwd) return fwd;
    }
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "local";
    }
  };

  async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new HttpError(400, "Некоректний JSON");
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, firstIssue(parsed.error));
    return parsed.data;
  }

  const idParam = (c: Context, name = "id"): number => {
    const id = Number(c.req.param(name));
    if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) throw notFound();
    return id;
  };

  const startSession = async (c: Context, userId: number) => {
    const token = await auth.createSession(ctx, userId, c.req.header("user-agent") ?? "");
    setCookie(c, cookieName, token, {
      httpOnly: true,
      secure: opts.secureCookies,
      sameSite: "Lax",
      path: "/",
      maxAge: auth.SESSION_TTL_MS / 1000,
    });
  };

  const demoForbidden = () =>
    new HttpError(403, "Це спільний демо-акаунт: змінювати профіль і сеанси не можна. Зареєструйте власний акаунт.");

  /** CSRF defence: state-changing requests must be same-origin JSON. */
  const sameOriginJson: MiddlewareHandler = async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
    const origin = c.req.header("origin");
    if (origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch {
        /* invalid origin → rejected below */
      }
      const allowed = origin === opts.publicOrigin || originHost === c.req.header("host");
      if (!allowed) throw new HttpError(403, "Запит з іншого сайту відхилено");
    }
    if (method !== "DELETE" && !(c.req.header("content-type") ?? "").startsWith("application/json")) {
      throw new HttpError(415, "Очікується application/json");
    }
    await next();
  };

  const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
    const session = await auth.resolveSession(ctx, getCookie(c, cookieName));
    if (!session) throw new HttpError(401, "Потрібно увійти");
    c.set("user", session.user);
    c.set("sessionId", session.sessionId);
    if (c.req.method !== "GET" && !limits.writes.take(String(session.user.id))) {
      throw new HttpError(429, "Забагато дій за хвилину. Зачекайте трохи");
    }
    await next();
  };

  // ---------- public API ----------

  const api = new Hono<Env>();
  api.use(
    "*",
    bodyLimit({
      maxSize: 32 * 1024,
      onError: () => {
        throw new HttpError(413, "Запит завеликий");
      },
    }),
  );
  api.use("*", sameOriginJson);

  api.get("/health", async (c) => {
    await ctx.db.one("SELECT 1");
    return c.json({ ok: true });
  });

  api.post("/auth/register", async (c) => {
    if (!limits.registerPerIp.take(clientIp(c)) || !limits.registerGlobal.take("all")) {
      throw new HttpError(429, "Забагато реєстрацій. Спробуйте пізніше");
    }
    const input = await body(c, registerSchema);
    const userId = await auth.registerUser(ctx, input);
    await onboardUser(ctx, userId);
    await startSession(c, userId);
    return c.json(await toMe(ctx, (await getUser(ctx, userId))!), 201);
  });

  api.post("/auth/login", async (c) => {
    const input = await body(c, loginSchema);
    const ip = clientIp(c);
    const account = input.username.toLowerCase();
    const ipUser = `${ip}|${account}`;
    if (!limits.loginPerIp.take(ip) || !limits.loginPerIpUser.take(ipUser) || !limits.loginPerAccount.take(account)) {
      throw new HttpError(429, "Забагато спроб входу. Зачекайте кілька хвилин");
    }
    const user = await auth.authenticate(ctx, input.username, input.password);
    limits.loginPerIpUser.reset(ipUser);
    await startSession(c, user.id);
    return c.json(await toMe(ctx, user));
  });

  api.post("/auth/logout", async (c) => {
    await auth.destroySession(ctx, getCookie(c, cookieName));
    deleteCookie(c, cookieName, { path: "/", secure: opts.secureCookies });
    return c.body(null, 204);
  });

  // ---------- authenticated API ----------

  const authed = new Hono<Env>();
  authed.use("*", requireAuth);

  authed.get("/me", async (c) => c.json(await toMe(ctx, c.get("user"))));

  authed.patch("/me", async (c) => {
    const me = c.get("user");
    const p = await body(c, updateMeSchema);
    if (me.is_demo && (p.displayName !== undefined || p.username !== undefined || p.bio !== undefined)) {
      throw demoForbidden();
    }
    if (p.username && p.username.toLowerCase() !== me.username.toLowerCase()) {
      if (await ctx.db.one("SELECT 1 FROM users WHERE lower(username) = lower(?) AND id <> ?", p.username, me.id)) {
        throw new HttpError(409, "Це ім'я користувача вже зайняте");
      }
    }
    const columns: Record<string, string | number | undefined> = {
      display_name: p.displayName,
      username: p.username,
      bio: p.bio,
      time_zone: p.timeZone,
      quiet_enabled: p.quietEnabled === undefined ? undefined : +p.quietEnabled,
      quiet_start: p.quietStart,
      quiet_end: p.quietEnd,
      show_local_time: p.showLocalTime === undefined ? undefined : +p.showLocalTime,
    };
    for (const [col, value] of Object.entries(columns)) {
      // Column names come from the fixed map above, never from the request.
      if (value !== undefined) await ctx.db.run(`UPDATE users SET ${col} = ? WHERE id = ?`, value, me.id);
    }
    const quietChanged = ["timeZone", "quietEnabled", "quietStart", "quietEnd"].some((k) => k in p);
    if (quietChanged) await messages.rescheduleHeldFor(ctx, me.id);
    return c.json(await toMe(ctx, (await getUser(ctx, me.id))!));
  });

  authed.delete("/me", async (c) => {
    const me = c.get("user");
    if (me.is_demo) throw demoForbidden();
    const { password } = await body(c, deleteAccountSchema);
    await auth.confirmPassword(me, password);
    const contacts = await contactIds(ctx, me.id);
    await auth.deleteAccount(ctx, me.id);
    // Their chats disappear for others; tell them to refresh the list.
    ctx.hub.publish(contacts, { type: "chat.new", chatId: 0 });
    deleteCookie(c, cookieName, { path: "/", secure: opts.secureCookies });
    return c.body(null, 204);
  });

  authed.post("/me/held/release", async (c) => {
    const released = await messages.releaseHeldFor(ctx, c.get("user").id);
    return c.json({ released });
  });

  authed.get("/me/sessions", async (c) => c.json(await auth.listSessions(ctx, c.get("user").id, c.get("sessionId"))));

  authed.delete("/me/sessions/:id", async (c) => {
    if (c.get("user").is_demo) throw demoForbidden();
    const id = idParam(c);
    if (id === c.get("sessionId")) throw new HttpError(400, "Щоб завершити поточний сеанс, вийдіть з акаунта");
    if (!(await auth.revokeSession(ctx, c.get("user").id, id))) throw notFound("Сеанс не знайдено");
    return c.body(null, 204);
  });

  authed.post("/me/sessions/terminate-others", async (c) => {
    if (c.get("user").is_demo) throw demoForbidden();
    const n = await auth.revokeOtherSessions(ctx, c.get("user").id, c.get("sessionId"));
    return c.json({ terminated: n });
  });

  authed.get("/users/search", async (c) => c.json(await searchUsers(ctx, c.get("user").id, c.req.query("q") ?? "")));

  authed.get("/users/:id", async (c) => {
    const user = await getUser(ctx, idParam(c));
    if (!user) throw notFound("Користувача не знайдено");
    return c.json((await publicUsersFor(ctx, c.get("user").id, [user]))[0]);
  });

  authed.post("/users/:id/block", async (c) => {
    await blockUser(ctx, c.get("user").id, idParam(c));
    return c.body(null, 204);
  });

  authed.delete("/users/:id/block", async (c) => {
    await unblockUser(ctx, c.get("user").id, idParam(c));
    return c.body(null, 204);
  });

  authed.get("/chats", async (c) => c.json(await listChats(ctx, c.get("user").id)));

  authed.post("/chats/private", async (c) => {
    const { userId } = await body(c, createPrivateSchema);
    const chatId = await openPrivateChat(ctx, c.get("user").id, userId);
    return c.json(await getChat(ctx, chatId, c.get("user").id));
  });

  authed.post("/chats/group", async (c) => {
    if (!limits.groups.take(String(c.get("user").id))) throw new HttpError(429, "Забагато нових груп. Спробуйте пізніше");
    const input = await body(c, createGroupSchema);
    const chatId = await createGroup(ctx, c.get("user").id, input.title, input.memberIds);
    return c.json(await getChat(ctx, chatId, c.get("user").id), 201);
  });

  authed.get("/chats/:id", async (c) => c.json(await getChat(ctx, idParam(c), c.get("user").id)));

  authed.patch("/chats/:id", async (c) => {
    const patch = await body(c, chatSettingsSchema);
    await updateChatSettings(ctx, c.get("user").id, idParam(c), patch);
    return c.json(await getChat(ctx, idParam(c), c.get("user").id));
  });

  authed.delete("/chats/:id", async (c) => {
    // Body is optional: no body = delete for me.
    const raw = (c.req.header("content-type") ?? "").startsWith("application/json") ? await body(c, deleteChatSchema) : null;
    await deleteChat(ctx, c.get("user"), idParam(c), raw?.forEveryone ?? false);
    return c.body(null, 204);
  });

  authed.get("/chats/:id/messages", async (c) =>
    c.json(await messages.listMessages(ctx, idParam(c), c.get("user").id, c.req.query("before") ?? null)),
  );

  authed.post("/chats/:id/messages", async (c) => {
    const me = c.get("user");
    if (!limits.send.take(String(me.id))) throw new HttpError(429, "Ви надсилаєте повідомлення занадто часто");
    const input = await body(c, sendMessageSchema);
    return c.json(await messages.sendMessage(ctx, me.id, idParam(c), input), 201);
  });

  authed.post("/chats/:id/read", async (c) => {
    const { upTo } = await body(c, readSchema);
    await messages.markRead(ctx, c.get("user").id, idParam(c), upTo);
    return c.body(null, 204);
  });

  authed.post("/chats/:id/typing", async (c) => {
    if (limits.typing.take(String(c.get("user").id))) await messages.sendTyping(ctx, c.get("user"), idParam(c));
    return c.body(null, 204);
  });

  authed.patch("/messages/:id", async (c) => {
    const { text } = await body(c, editMessageSchema);
    return c.json(await messages.editMessage(ctx, c.get("user").id, idParam(c), text));
  });

  authed.delete("/messages/:id", async (c) => {
    await messages.deleteMessage(ctx, c.get("user").id, idParam(c));
    return c.body(null, 204);
  });

  authed.post("/messages/:id/deliver-now", async (c) =>
    c.json(await messages.deliverNow(ctx, c.get("user").id, idParam(c))),
  );

  authed.put("/messages/:id/reaction", async (c) => {
    const { emoji } = await body(c, reactionSchema);
    return c.json(await messages.setReaction(ctx, c.get("user").id, idParam(c), emoji));
  });

  // Server-Sent Events: one stream per tab, only events addressed to this user.
  authed.get("/events", (c) => {
    const user = c.get("user");
    const sessionId = c.get("sessionId");
    if (ctx.hub.streamCount(user.id) >= MAX_STREAMS_PER_USER) {
      throw new HttpError(429, "Забагато відкритих вкладок");
    }
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let open = true;
      const unsubscribe = ctx.hub.subscribe(user.id, (event) => {
        void stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {});
      });
      stream.onAbort(() => {
        open = false;
        unsubscribe();
      });
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (open) {
        await stream.sleep(opts.ssePingMs ?? 20_000);
        if (!open) break;
        // A terminated session (logout elsewhere, account deleted) loses its live stream too.
        if (!(await auth.sessionExists(ctx, sessionId))) {
          open = false;
          unsubscribe();
          await stream.close();
          break;
        }
        await stream.writeSSE({ event: "ping", data: "" });
      }
    });
  });

  api.route("/", authed);
  app.route("/api", api);
  app.all("/api/*", () => {
    throw notFound();
  });

  return app;
}
