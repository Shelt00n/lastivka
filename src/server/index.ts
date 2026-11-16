import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { openDb } from "./db";
import { createApp } from "./app";
import { createBots } from "./bots";
import { Hub } from "./services/hub";
import { contactIds, touchLastSeen } from "./services/users";
import { deliverDue } from "./services/messages";
import { purgeExpiredSessions } from "./services/auth";
import { blockedBy } from "./services/blocks";
import { seedDemo } from "./seed";
import type { AppContext } from "./context";

const isProd = process.env.NODE_ENV === "production";
// `--dev`: Vite owns PORT and proxies /api to API_PORT. In production the host's PORT is used.
const isDev = process.argv.includes("--dev");
const port = Number((isDev ? process.env.API_PORT : (process.env.PORT ?? process.env.API_PORT)) ?? 3001);
const staticDir = process.env.STATIC_DIR ?? "dist/web";
const demoPassword = process.env.DEMO_PASSWORD ?? "lastivka-demo";

if (isProd && !process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required in production");
  process.exit(1);
}

// PostgreSQL in production; local dev without DATABASE_URL uses PGlite (embedded Postgres) in ./data.
const db = await openDb({ url: process.env.DATABASE_URL, dataDir: join(process.env.DATA_DIR ?? "data", "pglite") });

const ctx: AppContext = {
  db,
  bots: createBots(),
  now: Date.now,
  background: (task) => void task.catch((err) => console.error("[background]", err)),
  hub: new Hub((userId, online) => {
    // Presence: first tab opened → online; last tab closed → "last seen".
    void (async () => {
      await touchLastSeen(ctx, userId);
      // People this user blocked don't get to see them come online.
      const hidden = await blockedBy(ctx, userId);
      const audience = (await contactIds(ctx, userId)).filter((id) => !hidden.has(id));
      ctx.hub.publish(audience, { type: "presence", userId, online, lastSeenAt: ctx.now() });
    })().catch((err) => console.error("[presence]", err));
  }),
};

await seedDemo(ctx, demoPassword);

const app = createApp(ctx, {
  secureCookies: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : isProd,
  trustProxy: process.env.TRUST_PROXY === "true",
  publicOrigin: process.env.PUBLIC_ORIGIN,
});

// Production: the same server serves the built SPA → one origin, first-party cookies, no CORS.
const serveWeb = !isDev && existsSync(staticDir);
if (serveWeb) {
  app.use(
    "/assets/*",
    serveStatic({
      root: staticDir,
      onFound: (_path, c) => {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      },
    }),
  );
  app.use("/*", serveStatic({ root: staticDir }));
  app.get("*", serveStatic({ path: join(staticDir, "index.html") }));
}

/** Run a job periodically without overlapping runs. */
function every(ms: number, name: string, job: () => Promise<unknown>) {
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    job()
      .catch((err) => console.error(`[${name}]`, err))
      .finally(() => (running = false));
  }, ms).unref();
}

// Quiet-hours scheduler: release held messages whose window has ended.
every(5_000, "quiet-hours", async () => {
  const n = await deliverDue(ctx);
  if (n > 0) console.log(`[quiet-hours] delivered ${n} held message(s)`);
});
every(60 * 60_000, "sessions", () => purgeExpiredSessions(ctx));

const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "0.0.0.0" }, () => {
  console.log(
    `Ластівка on http://localhost:${port} · db: ${process.env.DATABASE_URL ? "PostgreSQL" : "PGlite (local)"}` +
      (serveWeb ? " · serving web build" : ""),
  );
});

// Graceful shutdown on redeploy: stop accepting connections, close the DB pool.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close();
    void db.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
