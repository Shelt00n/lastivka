import { openDb, TABLES, type Db } from "../../src/server/db";
import { createApp } from "../../src/server/app";
import { Hub } from "../../src/server/services/hub";
import { ensureBots } from "../../src/server/seed";
import type { AppContext } from "../../src/server/context";
import type { BotRegistry } from "../../src/server/bots";
import type { ServerEvent } from "../../src/shared/types";

export const PASSWORD = "correct-horse-42";

// One embedded PostgreSQL (PGlite, in memory) per test file; wiped before every test.
let shared: Promise<Db> | null = null;
// Background work (bot replies) of the previous test must finish before the DB is wiped.
const leftovers: Promise<unknown>[] = [];
async function freshDb(): Promise<Db> {
  await Promise.allSettled(leftovers.splice(0));
  shared ??= openDb({});
  const db = await shared;
  await db.exec(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
  return db;
}

/** Isolated app per test: empty PostgreSQL, controllable clock, fake bots (no network). */
export async function createTestApp(startAt = Date.UTC(2026, 10, 16, 12, 0)) {
  let now = startAt;
  const tasks: Promise<unknown>[] = [];
  const bots: BotRegistry = {
    reply: async (kind, text) => ({ text: `${kind}:${text}`, buttons: ["ok"] }),
    welcome: () => ({ text: "hello" }),
  };
  const ctx: AppContext = {
    db: await freshDb(),
    hub: new Hub(),
    bots,
    now: () => now,
    background: (t) => {
      tasks.push(t);
      leftovers.push(t);
    },
  };
  await ensureBots(ctx);
  const app = createApp(ctx, { secureCookies: false, trustProxy: false });

  return {
    ctx,
    app,
    setNow: (t: number) => (now = t),
    flush: async () => {
      while (tasks.length) await Promise.all(tasks.splice(0));
    },
    client: () => new TestClient(app),
    /** Collect SSE events that would be sent to a user. */
    listen(userId: number) {
      const events: ServerEvent[] = [];
      ctx.hub.subscribe(userId, (e) => events.push(e));
      return events;
    },
  };
}

type App = ReturnType<typeof createApp>;
export type TestApp = Awaited<ReturnType<typeof createTestApp>>;

export class TestClient {
  cookie = "";
  me: { id: number; username: string } | null = null;

  constructor(private readonly app: App) {}

  async req<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const hasBody = method !== "GET" && (method !== "DELETE" || body !== undefined);
    const res = await this.app.request(`/api${path}`, {
      method,
      headers: {
        host: "localhost",
        ...(hasBody ? { "content-type": "application/json" } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      body: hasBody ? (typeof body === "string" ? body : JSON.stringify(body ?? {})) : undefined,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.cookie = /max-age=0/i.test(setCookie) ? "" : setCookie.split(";")[0]!;
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, data: data as T, headers: res.headers };
  }

  async register(username: string, extra: Record<string, unknown> = {}) {
    const res = await this.req("POST", "/auth/register", {
      username,
      displayName: username[0]!.toUpperCase() + username.slice(1),
      password: PASSWORD,
      ...extra,
    });
    if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.data)}`);
    this.me = res.data;
    return res.data as { id: number; username: string };
  }

  async login(username: string, password = PASSWORD) {
    const res = await this.req("POST", "/auth/login", { username, password });
    if (res.status === 200) this.me = res.data;
    return res;
  }

  async openChat(userId: number): Promise<number> {
    const res = await this.req("POST", "/chats/private", { userId });
    if (res.status !== 200) throw new Error(`openChat failed: ${res.status}`);
    return res.data.id;
  }

  async send(chatId: number, text: string, extra: Record<string, unknown> = {}) {
    return this.req("POST", `/chats/${chatId}/messages`, { text, ...extra });
  }

  async messages(chatId: number) {
    const res = await this.req("GET", `/chats/${chatId}/messages`);
    return res.data?.messages as { id: number; text: string; deliverAt: number | null; createdAt: number }[];
  }
}
