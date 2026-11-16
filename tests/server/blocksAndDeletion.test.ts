import { beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp, type TestClient } from "./helpers";

const json = { "content-type": "application/json" };

describe("blocking", () => {
  let t: TestApp;
  let alice: TestClient, bob: TestClient;
  let chatId: number, bobId: number, aliceId: number;

  beforeEach(async () => {
    t = await createTestApp();
    alice = t.client();
    bob = t.client();
    aliceId = (await alice.register("alice")).id;
    bobId = (await bob.register("bob")).id;
    chatId = await alice.openChat(bobId);
    await alice.send(chatId, "привіт", { delivery: "now" });
  });

  it("stops messages in both directions until unblocked", async () => {
    expect((await alice.req("POST", `/users/${bobId}/block`)).status).toBe(204);
    const fromBob = await bob.send(chatId, "чому мовчиш?", { delivery: "now" });
    expect(fromBob.status).toBe(403);
    expect((await alice.send(chatId, "тест", { delivery: "now" })).status).toBe(403);

    expect((await alice.req("DELETE", `/users/${bobId}/block`)).status).toBe(204);
    expect((await bob.send(chatId, "знову можна", { delivery: "now" })).status).toBe(201);
  });

  it("tells only the blocker about the block", async () => {
    await alice.req("POST", `/users/${bobId}/block`);
    const seenByAlice = (await alice.req("GET", `/chats/${chatId}`)).data;
    const seenByBob = (await bob.req("GET", `/chats/${chatId}`)).data;
    expect(seenByAlice.peer.blockedByMe).toBe(true);
    expect(seenByBob.peer.blockedByMe).toBe(false);
  });

  it("hides the blocker's online status and last seen from the blocked person", async () => {
    t.listen(aliceId); // alice is online
    await alice.req("POST", `/users/${bobId}/block`);
    const peer = (await bob.req("GET", `/chats/${chatId}`)).data.peer;
    expect(peer.online).toBe(false);
    expect(peer.lastSeenAt).toBeNull();
  });

  it("does not deliver typing between blocked users", async () => {
    await alice.req("POST", `/users/${bobId}/block`);
    const aliceEvents = t.listen(aliceId);
    await bob.req("POST", `/chats/${chatId}/typing`);
    expect(aliceEvents.filter((e) => e.type === "typing")).toEqual([]);
  });

  it("does not affect groups", async () => {
    const group = (await alice.req("POST", "/chats/group", { title: "G", memberIds: [bobId] })).data.id;
    await alice.req("POST", `/users/${bobId}/block`);
    expect((await bob.send(group, "у групі можна")).status).toBe(201);
  });

  it("rejects blocking yourself, bots and unknown users", async () => {
    expect((await alice.req("POST", `/users/${aliceId}/block`)).status).toBe(400);
    const bots = (await alice.req("GET", "/users/search?q=bot")).data as { id: number }[];
    expect((await alice.req("POST", `/users/${bots[0]!.id}/block`)).status).toBe(400);
    expect((await alice.req("POST", "/users/99999/block")).status).toBe(404);
  });
});

describe("deleting chats", () => {
  let t: TestApp;
  let alice: TestClient, bob: TestClient, carol: TestClient;
  let chatId: number, bobId: number;

  beforeEach(async () => {
    t = await createTestApp();
    alice = t.client();
    bob = t.client();
    carol = t.client();
    await alice.register("alice");
    bobId = (await bob.register("bob")).id;
    await carol.register("carol");
    chatId = await alice.openChat(bobId);
    await alice.send(chatId, "старе повідомлення", { delivery: "now" });
  });

  const listIds = async (c: TestClient) => ((await c.req("GET", "/chats")).data as { id: number }[]).map((x) => x.id);

  it("for me: clears my history and hides the chat, the other side keeps everything", async () => {
    expect((await alice.req("DELETE", `/chats/${chatId}`)).status).toBe(204);
    expect(await listIds(alice)).not.toContain(chatId);
    expect(await alice.messages(chatId)).toEqual([]);
    expect((await bob.messages(chatId)).map((m) => m.text)).toEqual(["старе повідомлення"]);
  });

  it("for me: a new message brings the chat back, without the old history", async () => {
    await alice.req("DELETE", `/chats/${chatId}`);
    t.setNow(t.ctx.now() + 1000);
    await bob.send(chatId, "нове", { delivery: "now" });
    expect(await listIds(alice)).toContain(chatId);
    expect((await alice.messages(chatId)).map((m) => m.text)).toEqual(["нове"]);
  });

  it("for me: old messages can no longer be reacted to or edited by me", async () => {
    const old = (await alice.messages(chatId))[0]!;
    await alice.req("DELETE", `/chats/${chatId}`);
    expect((await alice.req("PUT", `/messages/${old.id}/reaction`, { emoji: "👍" })).status).toBe(404);
    expect((await alice.req("PATCH", `/messages/${old.id}`, { text: "x" })).status).toBe(404);
  });

  it("for everyone: removes the chat and its messages for both and notifies them", async () => {
    const bobEvents = t.listen(bobId);
    const res = await alice.req("DELETE", `/chats/${chatId}`, { forEveryone: true }, json);
    expect(res.status).toBe(204);
    expect(bobEvents).toContainEqual({ type: "chat.deleted", chatId });
    expect(await listIds(bob)).not.toContain(chatId);
    expect((await bob.req("GET", `/chats/${chatId}/messages`)).status).toBe(404);
    expect(await t.ctx.db.one("SELECT 1 FROM messages WHERE text = 'старе повідомлення'")).toBeUndefined();
  });

  it("outsiders cannot delete someone else's chat", async () => {
    expect((await carol.req("DELETE", `/chats/${chatId}`, { forEveryone: true }, json)).status).toBe(404);
    expect((await bob.messages(chatId)).length).toBe(1);
  });

  it("groups: members leave, only the owner deletes for everyone, ownership passes on", async () => {
    const carolId = carol.me!.id;
    const group = (await alice.req("POST", "/chats/group", { title: "G", memberIds: [bobId, carolId] })).data.id;
    expect((await bob.req("DELETE", `/chats/${group}`, { forEveryone: true }, json)).status).toBe(403);
    expect((await bob.req("DELETE", `/chats/${group}`)).status).toBe(204);
    expect(await listIds(bob)).not.toContain(group);
    expect((await alice.req("GET", `/chats/${group}`)).data.memberCount).toBe(2);

    expect((await alice.req("DELETE", `/chats/${group}`)).status).toBe(204); // owner leaves
    expect((await carol.req("GET", `/chats/${group}`)).data.isOwner).toBe(true);
    expect((await carol.req("DELETE", `/chats/${group}`, { forEveryone: true }, json)).status).toBe(204);
    expect(await t.ctx.db.one("SELECT 1 FROM chats WHERE id = ?", group)).toBeUndefined();
  });

  it("Saved Messages: deleting removes the notes", async () => {
    const saved = ((await alice.req("GET", "/chats")).data as { id: number; isSaved: boolean }[]).find((c) => c.isSaved)!;
    await alice.send(saved.id, "нотатка");
    expect((await alice.req("DELETE", `/chats/${saved.id}`)).status).toBe(204);
    expect(await alice.messages(saved.id)).toEqual([]);
  });

  it("shared demo accounts can delete only for themselves", async () => {
    await t.ctx.db.run("UPDATE users SET is_demo = 1 WHERE username = 'alice'");
    expect((await alice.req("DELETE", `/chats/${chatId}`, { forEveryone: true }, json)).status).toBe(403);
    expect((await alice.req("DELETE", `/chats/${chatId}`)).status).toBe(204);
    expect((await bob.messages(chatId)).length).toBe(1);
  });
});
