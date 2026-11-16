import { withDb, type AppContext } from "./context";
import { hashPassword, hueFor } from "./security";
import { BOT_ACCOUNTS } from "./bots";
import { openPrivateChat } from "./services/chats";

const MIN = 60_000;

async function insertMessage(
  ctx: AppContext,
  chatId: number,
  senderId: number,
  text: string,
  at: number,
  buttons?: readonly string[],
): Promise<number> {
  const row = await ctx.db.one<{ id: number }>(
    "INSERT INTO messages (chat_id, sender_id, text, buttons, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
    chatId,
    senderId,
    text,
    buttons?.length ? JSON.stringify(buttons) : null,
    at,
  );
  return row!.id;
}

async function setRead(ctx: AppContext, chatId: number, userId: number, at: number) {
  await ctx.db.run("UPDATE chat_members SET last_read_at = ? WHERE chat_id = ? AND user_id = ?", at, chatId, userId);
}

async function react(ctx: AppContext, messageId: number, userId: number, emoji: string, at: number) {
  await ctx.db.run(
    "INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)",
    messageId,
    userId,
    emoji,
    at,
  );
}

export async function ensureBots(ctx: AppContext) {
  for (const b of BOT_ACCOUNTS) {
    await ctx.db.run(
      `INSERT INTO users (username, display_name, bio, is_bot, bot_kind, avatar_hue, created_at)
       VALUES (?, ?, ?, 1, ?, ?, ?) ON CONFLICT DO NOTHING`,
      b.username,
      b.displayName,
      b.bio,
      b.kind,
      { weather: 200, rates: 145, wiki: 25 }[b.kind],
      ctx.now(),
    );
  }
}

/** Every new account gets "Saved Messages" and a greeting from each bot. */
export async function onboardUser(ctx: AppContext, userId: number, at = ctx.now()) {
  await ctx.db.tx(async (db) => {
    const t = withDb(ctx, db);
    const saved = await openPrivateChat(t, userId, userId);
    await insertMessage(t, saved, userId, "Це «Збережене» — ваші нотатки, посилання та ідеї. Бачите лише ви 🔒", at - 3 * MIN);
    await setRead(t, saved, userId, at);

    for (const [i, b] of BOT_ACCOUNTS.entries()) {
      const bot = await t.db.one<{ id: number }>("SELECT id FROM users WHERE username = ?", b.username);
      if (!bot) continue;
      const chatId = await openPrivateChat(t, userId, bot.id);
      const welcome = t.bots.welcome(b.kind);
      await insertMessage(t, chatId, bot.id, welcome.text, at - (i + 4) * MIN, welcome.buttons);
      await setRead(t, chatId, userId, at);
    }
  });
}

interface SeedUser {
  username: string;
  displayName: string;
  bio: string;
  timeZone: string;
  quiet?: [number, number];
  password?: string;
}

/** Demo data so reviewers land in a lively app. Runs only once, on an empty database. */
export async function seedDemo(ctx: AppContext, demoPassword: string) {
  await ensureBots(ctx);
  if (await ctx.db.one("SELECT 1 FROM users WHERE username = 'demo'")) return;

  const people: SeedUser[] = [
    { username: "demo", displayName: "Андрій Коваленко", bio: "Тестую Ластівку 🐦", timeZone: "Europe/Kyiv", password: demoPassword },
    { username: "demo2", displayName: "Марія Шевчук", bio: "Друга демо-сторінка: відкрийте її в іншому браузері", timeZone: "Europe/Kyiv", password: demoPassword },
    { username: "olena", displayName: "Олена Бондар", bio: "Дизайнерка інтерфейсів ☕", timeZone: "Europe/Kyiv", quiet: [23 * 60, 8 * 60] },
    { username: "kenji", displayName: "Kenji Tanaka", bio: "Backend · Токіо 🗼", timeZone: "Asia/Tokyo", quiet: [23 * 60, 7 * 60 + 30] },
    { username: "sofia", displayName: "Софія Мельник", bio: "Продакт-менеджерка у Нью-Йорку 🗽", timeZone: "America/New_York", quiet: [22 * 60 + 30, 7 * 60] },
    { username: "ihor", displayName: "Ігор Савчук", bio: "Фронтенд, Варшава", timeZone: "Europe/Warsaw" },
  ];

  const hashes = new Map<string, string>();
  for (const p of people) if (p.password) hashes.set(p.username, await hashPassword(p.password));

  const now = ctx.now();
  const ago = (minutes: number) => now - minutes * MIN;

  await ctx.db.tx(async (db) => {
    const t = withDb(ctx, db);
    const id: Record<string, number> = {};
    for (const p of people) {
      const row = await t.db.one<{ id: number }>(
        `INSERT INTO users (username, display_name, bio, password_hash, is_demo, avatar_hue, time_zone,
                            quiet_enabled, quiet_start, quiet_end, last_seen_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        p.username,
        p.displayName,
        p.bio,
        hashes.get(p.username) ?? null, // seeded colleagues can't log in
        p.password ? 1 : 0,
        hueFor(p.username),
        p.timeZone,
        p.quiet ? 1 : 0,
        p.quiet?.[0] ?? 23 * 60,
        p.quiet?.[1] ?? 8 * 60,
        ago(Math.floor(Math.random() * 90) + 5),
        ago(60 * 24 * 30),
      );
      id[p.username] = row!.id;
    }
    const u = (name: string) => id[name]!;

    // Olena
    let c = await openPrivateChat(t, u("demo"), u("olena"));
    await insertMessage(t, c, u("olena"), "Привіт! Глянеш макети онбордингу? Скинула у Figma 🎨", ago(190));
    await insertMessage(t, c, u("demo"), "Привіт! Так, уже дивлюсь", ago(185));
    await insertMessage(t, c, u("demo"), "Кольори супер, але кнопка «Далі» губиться на темній темі", ago(184));
    await insertMessage(t, c, u("olena"), "Ага, бачу. Зроблю контрастнішою", ago(170));
    await insertMessage(t, c, u("olena"), "До речі, ти вже пробував тихі години?", ago(169));
    await insertMessage(t, c, u("demo"), "Так! Якщо написати комусь уночі, повідомлення прийде зранку 🌙", ago(120));
    await insertMessage(t, c, u("olena"), "Нарешті ніхто не будитиме о третій ночі питанням «а ти не спиш?» 😅", ago(118));
    await insertMessage(t, c, u("olena"), "Скинь, будь ласка, фінальний текст для вітального екрана", ago(31));
    await insertMessage(t, c, u("olena"), "Хочу сьогодні закрити задачу", ago(30));
    await setRead(t, c, u("demo"), ago(118));
    await setRead(t, c, u("olena"), ago(118));

    // Kenji
    c = await openPrivateChat(t, u("demo"), u("kenji"));
    await insertMessage(t, c, u("kenji"), "Hi Andrii! Deploy is green ✅", ago(1500));
    await insertMessage(t, c, u("demo"), "Дякую! Як там API для реакцій?", ago(1490));
    await insertMessage(t, c, u("kenji"), "Done: PUT /messages/:id/reaction. All tests pass", ago(1480));
    const fire = await insertMessage(t, c, u("demo"), "Супер 🔥", ago(1470));
    await react(t, fire, u("kenji"), "👍", ago(1460));
    await setRead(t, c, u("demo"), ago(1460));
    await setRead(t, c, u("kenji"), ago(1460));

    // Sofia
    c = await openPrivateChat(t, u("demo"), u("sofia"));
    await insertMessage(t, c, u("sofia"), "Андрію, завтра о 17:00 за Києвом дзвінок щодо роадмапу — підходить?", ago(2900));
    await insertMessage(t, c, u("demo"), "Підходить 👍", ago(2880));
    await insertMessage(t, c, u("sofia"), "Тоді надсилаю запрошення", ago(2870));
    await setRead(t, c, u("demo"), ago(2860));
    await setRead(t, c, u("sofia"), ago(2860));

    // Ihor
    c = await openPrivateChat(t, u("demo"), u("ihor"));
    await insertMessage(t, c, u("ihor"), "Бачив новий Vite? Збірка в рази швидша", ago(4320));
    await insertMessage(t, c, u("demo"), "Ще ні, гляну на вихідних", ago(4300));
    await setRead(t, c, u("demo"), ago(4300));
    await setRead(t, c, u("ihor"), ago(4290));

    // demo ↔ demo2 (for live testing in two browsers)
    c = await openPrivateChat(t, u("demo"), u("demo2"));
    await insertMessage(t, c, u("demo2"), "Привіт! Це друга демо-сторінка 👋", ago(61));
    await insertMessage(t, c, u("demo2"), "Увійди як @demo2 в іншому браузері — і переписуйся сам із собою в реальному часі", ago(60));
    await setRead(t, c, u("demo2"), ago(60));

    // Group
    const group = (await t.db.one<{ id: number }>(
      "INSERT INTO chats (type, title, avatar_hue, created_by, created_at) VALUES ('group', ?, 265, ?, ?) RETURNING id",
      "Команда «Ластівки»",
      u("demo"),
      ago(60 * 24 * 7),
    ))!.id;
    for (const name of ["demo", "olena", "kenji", "ihor", "demo2"]) {
      await t.db.run(
        "INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)",
        group,
        u(name),
        name === "demo" ? "owner" : "member",
        ago(60 * 24 * 7),
      );
    }
    await insertMessage(t, group, u("ihor"), "Всім привіт! Реліз у пʼятницю?", ago(300));
    await insertMessage(t, group, u("olena"), "Так, якщо встигнемо з темною темою", ago(295));
    await insertMessage(t, group, u("kenji"), "Backend is ready 🚀", ago(290));
    const plan = await insertMessage(t, group, u("demo"), "Тоді плануємо на пʼятницю, 12:00", ago(280));
    for (const [name, emoji] of [["olena", "👍"], ["ihor", "👍"], ["kenji", "🔥"]] as const) {
      await react(t, plan, u(name), emoji, ago(275));
    }
    await insertMessage(t, group, u("ihor"), "Додав анімацію відправки повідомлення — гляньте 👀", ago(40));
    for (const name of ["olena", "kenji", "ihor", "demo2", "demo"]) await setRead(t, group, u(name), ago(270));
    await t.db.run("UPDATE chat_members SET pinned = 1 WHERE chat_id = ? AND user_id = ?", group, u("demo"));

    // Demo accounts "joined" a few days ago, so personal chats stay on top.
    for (const name of ["demo", "demo2"]) await onboardUser(t, u(name), now - 3 * 24 * 60 * MIN);
    const saved = await openPrivateChat(t, u("demo"), u("demo"));
    await insertMessage(t, saved, u("demo"), "Ідея: таймер самознищення для повідомлень?", ago(2));
    await setRead(t, saved, u("demo"), now);
  });
}
