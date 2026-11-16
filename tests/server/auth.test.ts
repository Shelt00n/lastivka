import { describe, expect, it } from "vitest";
import { createTestApp, PASSWORD } from "./helpers";
import { hashPassword, verifyPassword } from "../../src/server/security";

describe("passwords", () => {
  it("hashes with a random salt and verifies", async () => {
    const a = await hashPassword("secret-123");
    const b = await hashPassword("secret-123");
    expect(a).not.toBe(b);
    expect(a).not.toContain("secret-123");
    expect(await verifyPassword("secret-123", a)).toBe(true);
    expect(await verifyPassword("secret-124", a)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("registration and login", () => {
  it("registers, sets an httpOnly session cookie and onboards the user", async () => {
    const t = await createTestApp();
    const alice = t.client();
    const res = await alice.req("POST", "/auth/register", { username: "alice", displayName: "Alice", password: PASSWORD });
    expect(res.status).toBe(201);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const chats = await alice.req("GET", "/chats");
    const titles = chats.data.map((c: { title: string }) => c.title);
    expect(titles).toEqual(expect.arrayContaining(["Збережене", "Погода", "Курси НБУ", "Вікі"]));
  });

  it("stores only hashes of passwords and session tokens", async () => {
    const t = await createTestApp();
    const alice = t.client();
    await alice.register("alice");
    const user = (await t.ctx.db.one<{ password_hash: string }>("SELECT password_hash FROM users WHERE username = 'alice'"))!;
    expect(user.password_hash.startsWith("scrypt$")).toBe(true);
    expect(user.password_hash).not.toContain(PASSWORD);
    const token = alice.cookie.split("=")[1]!;
    const sessions = await t.ctx.db.all<{ token_hash: string }>("SELECT token_hash FROM sessions");
    expect(sessions.map((s) => s.token_hash)).not.toContain(token);
  });

  it("rejects duplicate usernames case-insensitively", async () => {
    const t = await createTestApp();
    await t.client().register("alice");
    const res = await t.client().req("POST", "/auth/register", { username: "ALICE", displayName: "A", password: PASSWORD });
    expect(res.status).toBe(409);
  });

  it("validates input", async () => {
    const t = await createTestApp();
    const c = t.client();
    expect((await c.req("POST", "/auth/register", { username: "a", displayName: "A", password: PASSWORD })).status).toBe(400);
    expect((await c.req("POST", "/auth/register", { username: "alice", displayName: "A", password: "short" })).status).toBe(400);
    expect((await c.req("POST", "/auth/register", "{not json")).status).toBe(400);
  });

  it("gives the same answer for unknown user and wrong password", async () => {
    const t = await createTestApp();
    await t.client().register("alice");
    const wrong = await t.client().login("alice", "wrong-password");
    const unknown = await t.client().login("nobody", "wrong-password");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.data.error).toBe(unknown.data.error);
  });

  it("bots cannot log in", async () => {
    const t = await createTestApp();
    expect((await t.client().login("pogoda_bot", "anything")).status).toBe(401);
  });

  it("rate-limits password guessing", async () => {
    const t = await createTestApp();
    await t.client().register("alice");
    const attacker = t.client();
    for (let i = 0; i < 10; i++) expect((await attacker.login("alice", `guess-${i}`)).status).toBe(401);
    expect((await attacker.login("alice", PASSWORD)).status).toBe(429);
  });

  it("logout destroys the session server-side", async () => {
    const t = await createTestApp();
    const alice = t.client();
    await alice.register("alice");
    const stolenCookie = alice.cookie;
    expect((await alice.req("POST", "/auth/logout")).status).toBe(204);
    const replay = t.client();
    replay.cookie = stolenCookie;
    expect((await replay.req("GET", "/me")).status).toBe(401);
  });
});

describe("sessions", () => {
  it("lets a user terminate another of their sessions, which stops working immediately", async () => {
    const t = await createTestApp();
    const phone = t.client();
    await phone.register("alice");
    const laptop = t.client();
    await laptop.login("alice");

    const list = await phone.req("GET", "/me/sessions");
    expect(list.data).toHaveLength(2);
    const other = list.data.find((s: { current: boolean }) => !s.current);
    expect((await phone.req("DELETE", `/me/sessions/${other.id}`)).status).toBe(204);
    expect((await laptop.req("GET", "/me")).status).toBe(401);
    expect((await phone.req("GET", "/me")).status).toBe(200);
  });

  it("cannot terminate someone else's session", async () => {
    const t = await createTestApp();
    const alice = t.client();
    await alice.register("alice");
    const bob = t.client();
    await bob.register("bob");
    const bobSession = (await bob.req("GET", "/me/sessions")).data[0].id;
    expect((await alice.req("DELETE", `/me/sessions/${bobSession}`)).status).toBe(404);
    expect((await bob.req("GET", "/me")).status).toBe(200);
  });

  it("expires sessions after 30 days of inactivity", async () => {
    const t = await createTestApp();
    const alice = t.client();
    await alice.register("alice");
    t.setNow(t.ctx.now() + 31 * 24 * 3600_000);
    expect((await alice.req("GET", "/me")).status).toBe(401);
  });
});

describe("request hardening", () => {
  it("rejects cross-site state-changing requests (CSRF)", async () => {
    const t = await createTestApp();
    const alice = t.client();
    await alice.register("alice");
    const evil = await alice.req("PATCH", "/me", { bio: "pwned" }, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    const sameSite = await alice.req("PATCH", "/me", { bio: "ok" }, { origin: "http://localhost" });
    expect(sameSite.status).toBe(200);
  });

  it("only accepts JSON bodies, so HTML forms can't post", async () => {
    const t = await createTestApp();
    const alice = t.client();
    await alice.register("alice");
    const res = await alice.req("PATCH", "/me", "bio=pwned", { "content-type": "text/plain" });
    expect(res.status).toBe(415);
  });

  it("limits body size", async () => {
    const t = await createTestApp();
    const alice = t.client();
    await alice.register("alice");
    const res = await alice.req("PATCH", "/me", { bio: "x".repeat(40_000) });
    expect(res.status).toBe(413);
  });

  it("rejects unknown fields when updating the profile", async () => {
    const t = await createTestApp();
    const alice = t.client();
    await alice.register("alice");
    expect((await alice.req("PATCH", "/me", { is_bot: 1 })).status).toBe(400);
  });

  it("sends security headers", async () => {
    const t = await createTestApp();
    const res = await t.client().req("GET", "/health");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBeTruthy();
  });
});

describe("shared demo accounts", () => {
  async function demoClient() {
    const t = await createTestApp();
    const demo = t.client();
    await demo.register("demo");
    await t.ctx.db.run("UPDATE users SET is_demo = 1 WHERE username = 'demo'");
    return { t, demo };
  }

  it("cannot be renamed or vandalised", async () => {
    const { demo } = await demoClient();
    expect((await demo.req("PATCH", "/me", { displayName: "spam" })).status).toBe(403);
    expect((await demo.req("PATCH", "/me", { username: "spam_account" })).status).toBe(403);
    expect((await demo.req("PATCH", "/me", { bio: "spam" })).status).toBe(403);
    expect((await demo.req("GET", "/me")).data.isDemo).toBe(true);
  });

  it("can still try the quiet hours feature", async () => {
    const { demo } = await demoClient();
    expect((await demo.req("PATCH", "/me", { quietEnabled: true, quietStart: 60 })).status).toBe(200);
  });

  it("cannot kick other reviewers out or be deleted", async () => {
    const { t, demo } = await demoClient();
    const other = t.client();
    await other.login("demo");
    expect((await demo.req("POST", "/me/sessions/terminate-others")).status).toBe(403);
    const sessions = (await demo.req("GET", "/me/sessions")).data as { id: number; current: boolean }[];
    expect((await demo.req("DELETE", `/me/sessions/${sessions.find((s) => !s.current)!.id}`)).status).toBe(403);
    expect((await demo.req("DELETE", "/me", { password: PASSWORD }, { "content-type": "application/json" })).status).toBe(403);
    expect((await other.req("GET", "/me")).status).toBe(200);
  });
});

describe("account deletion", () => {
  it("requires the password and removes the account with its data", async () => {
    const t = await createTestApp();
    const alice = t.client();
    const bob = t.client();
    await alice.register("alice");
    const b = await bob.register("bob");
    const chatId = await alice.openChat(b.id);
    await alice.send(chatId, "секрет");

    const del = (password: string) =>
      alice.req("DELETE", "/me", { password }, { "content-type": "application/json" });
    expect((await del("wrong-password")).status).toBe(403);
    expect((await del(PASSWORD)).status).toBe(204);

    expect((await t.client().login("alice")).status).toBe(401);
    expect(await t.ctx.db.one("SELECT 1 FROM users WHERE username = 'alice'")).toBeUndefined();
    expect(await t.ctx.db.one("SELECT 1 FROM messages WHERE text = 'секрет'")).toBeUndefined();
    const bobChats = (await bob.req("GET", "/chats")).data as { id: number }[];
    expect(bobChats.map((c) => c.id)).not.toContain(chatId);
  });
});

describe("usernames", () => {
  it("are unique and log in case-insensitively", async () => {
    const t = await createTestApp();
    await t.client().register("Alice");
    expect((await t.client().login("aLiCe")).status).toBe(200);
  });
});
