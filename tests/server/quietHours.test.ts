import { beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp, type TestClient } from "./helpers";
import { deliverDue } from "../../src/server/services/messages";

/**
 * End-to-end behaviour of the new feature through the HTTP API:
 * a message to someone who is asleep is held and arrives when their quiet hours end.
 */

// 22:30Z = 00:30 in Kyiv (UTC+2 in November). Bob sleeps 23:00–08:00 → wakes at 06:00Z.
const NIGHT = Date.UTC(2026, 10, 16, 22, 30);
const WAKE = Date.UTC(2026, 10, 17, 6, 0);

describe("quiet hours delivery", () => {
  let t: TestApp;
  let alice: TestClient, bob: TestClient;
  let chatId: number;

  beforeEach(async () => {
    t = await createTestApp(NIGHT);
    alice = t.client();
    bob = t.client();
    await alice.register("alice");
    const b = await bob.register("bob", { timeZone: "Europe/Kyiv" });
    await bob.req("PATCH", "/me", { quietEnabled: true, quietStart: 23 * 60, quietEnd: 8 * 60 });
    chatId = await alice.openChat(b.id);
  });

  it("shows the sender that the recipient is in quiet hours", async () => {
    const chat = (await alice.req("GET", `/chats/${chatId}`)).data;
    expect(chat.peer.quiet).toEqual({ active: true, endsAt: WAKE, start: 23 * 60, end: 8 * 60 });
  });

  it("holds the message and hides it from the recipient", async () => {
    const sent = await alice.send(chatId, "Спиш?");
    expect(sent.status).toBe(201);
    expect(sent.data.deliverAt).toBe(WAKE);

    expect((await alice.messages(chatId)).map((m) => m.text)).toEqual(["Спиш?"]);
    expect(await bob.messages(chatId)).toEqual([]);

    const bobChats = (await bob.req("GET", "/chats")).data;
    expect(bobChats.find((c: { id: number }) => c.id === chatId)).toBeUndefined();
    const me = (await bob.req("GET", "/me")).data;
    expect(me.heldCount).toBe(1);
    expect(me.heldUntil).toBe(WAKE);
  });

  it("does not push the held message to the recipient in realtime", async () => {
    const bobEvents = t.listen(bob.me!.id);
    await alice.send(chatId, "Спиш?");
    expect(bobEvents.filter((e) => e.type === "message.new")).toEqual([]);
  });

  it("the recipient cannot see, react to or quote a held message", async () => {
    const { id } = (await alice.send(chatId, "Спиш?")).data;
    expect((await bob.req("PUT", `/messages/${id}/reaction`, { emoji: "👍" })).status).toBe(404);
    expect((await bob.req("POST", `/messages/${id}/deliver-now`)).status).toBe(404);
    expect((await bob.send(chatId, "?", { replyToId: id, delivery: "now" })).status).toBe(400);
  });

  it("delivers exactly when quiet hours end, with the delivery time as timestamp", async () => {
    await alice.send(chatId, "Доброго ранку ☀️");
    const bobEvents = t.listen(bob.me!.id);

    t.setNow(WAKE - 1000);
    expect(await deliverDue(t.ctx)).toBe(0);
    t.setNow(WAKE);
    expect(await deliverDue(t.ctx)).toBe(1);

    const [m] = await bob.messages(chatId);
    expect(m!.text).toBe("Доброго ранку ☀️");
    expect(m!.createdAt).toBe(WAKE);
    expect(bobEvents.some((e) => e.type === "message.new")).toBe(true);
    expect((await alice.messages(chatId))[0]!.deliverAt).toBeNull();
    expect((await bob.req("GET", "/me")).data.heldCount).toBe(0);
  });

  it("the sender can still send urgently", async () => {
    const sent = await alice.send(chatId, "Терміново!", { delivery: "now" });
    expect(sent.data.deliverAt).toBeNull();
    expect((await bob.messages(chatId)).map((m) => m.text)).toEqual(["Терміново!"]);
  });

  it("the sender can deliver a held message now, edit or cancel it", async () => {
    const first = (await alice.send(chatId, "раз")).data;
    const second = (await alice.send(chatId, "два")).data;
    expect((await alice.req("PATCH", `/messages/${first.id}`, { text: "раз!" })).status).toBe(200);
    expect((await alice.req("DELETE", `/messages/${second.id}`)).status).toBe(204);
    const now = await alice.req("POST", `/messages/${first.id}/deliver-now`);
    expect(now.data.deliverAt).toBeNull();
    expect((await bob.messages(chatId)).map((m) => m.text)).toEqual(["раз!"]);
  });

  it("a recipient who is awake anyway can get held messages early", async () => {
    await alice.send(chatId, "раз");
    await alice.send(chatId, "два");
    const res = await bob.req("POST", "/me/held/release");
    expect(res.data.released).toBe(2);
    expect((await bob.messages(chatId)).map((m) => m.text)).toEqual(["раз", "два"]);
  });

  it("turning quiet hours off releases held messages", async () => {
    await alice.send(chatId, "раз");
    await bob.req("PATCH", "/me", { quietEnabled: false });
    expect((await bob.messages(chatId)).map((m) => m.text)).toEqual(["раз"]);
  });

  it("changing the window reschedules held messages", async () => {
    const { id } = (await alice.send(chatId, "раз")).data;
    await bob.req("PATCH", "/me", { quietEnd: 7 * 60 });
    const held = (await alice.messages(chatId)).find((m) => m.id === id)!;
    expect(held.deliverAt).toBe(WAKE - 3600_000);
  });

  it("delivers immediately when the recipient is awake", async () => {
    t.setNow(Date.UTC(2026, 10, 17, 10, 0)); // 12:00 in Kyiv
    const sent = await alice.send(chatId, "Обід?");
    expect(sent.data.deliverAt).toBeNull();
  });

  it("never holds messages in groups, to bots or in Saved Messages", async () => {
    const group = (await alice.req("POST", "/chats/group", { title: "G", memberIds: [bob.me!.id] })).data.id;
    expect((await alice.send(group, "в групу")).data.deliverAt).toBeNull();

    const chats = (await bob.req("GET", "/chats")).data as { id: number; title: string; isSaved: boolean }[];
    const saved = chats.find((c) => c.isSaved)!;
    expect((await bob.send(saved.id, "нотатка")).data.deliverAt).toBeNull();

    const weather = chats.find((c) => c.title === "Погода")!;
    expect((await bob.send(weather.id, "Київ")).data.deliverAt).toBeNull();
  });
});

describe("bots in chats", () => {
  it("replies asynchronously through the bot registry", async () => {
    const t = await createTestApp();
    const alice = t.client();
    await alice.register("alice");
    const chats = (await alice.req("GET", "/chats")).data as { id: number; title: string }[];
    const rates = chats.find((c) => c.title === "Курси НБУ")!;
    await alice.send(rates.id, "USD");
    await t.flush();
    const msgs = (await alice.req("GET", `/chats/${rates.id}/messages`)).data.messages;
    expect(msgs.at(-1).text).toBe("rates:USD");
    expect(msgs.at(-1).buttons).toEqual(["ok"]);
  });
});
