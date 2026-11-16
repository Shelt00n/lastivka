import { beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp, type TestClient } from "./helpers";

/**
 * Authorization: the most important property of a messenger is that
 * nobody can read or touch a conversation they are not part of.
 */
describe("chat access control", () => {
  let t: TestApp;
  let alice: TestClient, bob: TestClient, carol: TestClient;
  let chatId: number, aliceMsg: number;

  beforeEach(async () => {
    t = await createTestApp();
    alice = t.client();
    bob = t.client();
    carol = t.client();
    await alice.register("alice");
    const b = await bob.register("bob");
    await carol.register("carol");
    chatId = await alice.openChat(b.id);
    aliceMsg = (await alice.send(chatId, "секрет для Боба")).data.id;
  });

  it("requires authentication", async () => {
    const anon = t.client();
    for (const path of ["/me", "/chats", `/chats/${chatId}/messages`, "/events", "/users/search?q=a"]) {
      expect((await anon.req("GET", path)).status, path).toBe(401);
    }
  });

  it("members can read the chat", async () => {
    expect((await bob.messages(chatId)).map((m) => m.text)).toEqual(["секрет для Боба"]);
  });

  it("outsiders get 404 for every chat endpoint (no existence leak)", async () => {
    expect((await carol.req("GET", `/chats/${chatId}`)).status).toBe(404);
    expect((await carol.req("GET", `/chats/${chatId}/messages`)).status).toBe(404);
    expect((await carol.send(chatId, "hi")).status).toBe(404);
    expect((await carol.req("POST", `/chats/${chatId}/read`, { upTo: Date.now() })).status).toBe(404);
    expect((await carol.req("POST", `/chats/${chatId}/typing`)).status).toBe(404);
    expect((await carol.req("PATCH", `/chats/${chatId}`, { pinned: true })).status).toBe(404);
  });

  it("outsiders cannot edit, delete or react to messages", async () => {
    expect((await carol.req("PATCH", `/messages/${aliceMsg}`, { text: "hacked" })).status).toBe(404);
    expect((await carol.req("DELETE", `/messages/${aliceMsg}`)).status).toBe(404);
    expect((await carol.req("PUT", `/messages/${aliceMsg}/reaction`, { emoji: "👍" })).status).toBe(404);
    expect((await bob.messages(chatId))[0]!.text).toBe("секрет для Боба");
  });

  it("outsiders do not see the chat in their list and cannot reply into it", async () => {
    const list = await carol.req("GET", "/chats");
    expect(list.data.map((c: { id: number }) => c.id)).not.toContain(chatId);
    const ownChat = await carol.openChat(alice.me!.id);
    const res = await carol.send(ownChat, "reply", { replyToId: aliceMsg });
    expect(res.status).toBe(400);
  });

  it("members can only edit and delete their own messages", async () => {
    expect((await bob.req("PATCH", `/messages/${aliceMsg}`, { text: "changed" })).status).toBe(403);
    expect((await bob.req("DELETE", `/messages/${aliceMsg}`)).status).toBe(403);
    expect((await alice.req("PATCH", `/messages/${aliceMsg}`, { text: "виправлено" })).status).toBe(200);
    const [m] = await bob.messages(chatId);
    expect(m!.text).toBe("виправлено");
    expect((await alice.req("DELETE", `/messages/${aliceMsg}`)).status).toBe(204);
    expect(await bob.messages(chatId)).toEqual([]);
  });

  it("realtime events reach only chat members", async () => {
    const bobEvents = t.listen(bob.me!.id);
    const carolEvents = t.listen(carol.me!.id);
    await alice.send(chatId, "live");
    expect(bobEvents.some((e) => e.type === "message.new" && e.message.text === "live")).toBe(true);
    expect(carolEvents).toEqual([]);
  });

  it("never exposes password hashes or private settings through user endpoints", async () => {
    const responses = [
      await carol.req("GET", `/users/${alice.me!.id}`),
      await carol.req("GET", "/users/search?q=ali"),
      await bob.req("GET", `/chats/${chatId}`),
    ];
    for (const r of responses) {
      const json = JSON.stringify(r.data);
      expect(json).not.toMatch(/scrypt|password|token/i);
    }
  });

  it("hides the exact quiet-hours window when the user hides their local time", async () => {
    await alice.req("PATCH", "/me", { quietEnabled: true, showLocalTime: false });
    const profile = (await carol.req("GET", `/users/${alice.me!.id}`)).data;
    expect(profile.timeZone).toBeNull();
    expect(profile.quiet.start).toBeNull();
    expect(profile.quiet.end).toBeNull();
  });

  it("rejects malformed ids and cursors", async () => {
    expect((await alice.req("GET", "/chats/abc")).status).toBe(404);
    expect((await alice.req("GET", `/chats/${chatId}/messages?before=1;DROP TABLE`)).status).toBe(400);
  });
});

describe("groups", () => {
  it("creates a group only with existing human users and notifies members", async () => {
    const t = await createTestApp();
    const alice = t.client();
    await alice.register("alice");
    const bob = t.client();
    const b = await bob.register("bob");
    const bobEvents = t.listen(b.id);

    const res = await alice.req("POST", "/chats/group", { title: "Команда", memberIds: [b.id] });
    expect(res.status).toBe(201);
    expect(res.data.memberCount).toBe(2);
    expect(bobEvents.some((e) => e.type === "chat.new")).toBe(true);

    expect((await alice.req("POST", "/chats/group", { title: "X", memberIds: [99999] })).status).toBe(400);
  });
});

describe("pagination", () => {
  it("pages through history with a stable cursor", async () => {
    const t = await createTestApp();
    const alice = t.client();
    const bob = t.client();
    await alice.register("alice");
    const b = await bob.register("bob");
    const chatId = await alice.openChat(b.id);
    const base = t.ctx.now();
    for (let i = 0; i < 45; i++) {
      t.setNow(base + i * 1000);
      await alice.send(chatId, `m${i}`, { delivery: "now" });
    }
    const first = await bob.req("GET", `/chats/${chatId}/messages`);
    expect(first.data.messages).toHaveLength(40);
    expect(first.data.messages.at(-1).text).toBe("m44");
    expect(first.data.hasMore).toBe(true);
    const second = await bob.req("GET", `/chats/${chatId}/messages?before=${first.data.nextCursor}`);
    expect(second.data.messages.map((m: { text: string }) => m.text)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(second.data.hasMore).toBe(false);
  });
});
