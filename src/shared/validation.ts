import { z } from "zod";
import { isValidTimeZone, MINUTES_IN_DAY } from "./quietHours";

export const LIMITS = {
  messageText: 4096,
  displayName: 64,
  bio: 140,
  groupTitle: 64,
  groupMembers: 50,
  passwordMin: 8,
  passwordMax: 128,
} as const;

export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"] as const;

const trimmed = (max: number) => z.string().trim().max(max);

export const usernameSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]{2,31}$/, "Ім'я користувача: 3–32 символи, латиниця, цифри та _, починається з літери");

export const passwordSchema = z
  .string()
  .min(LIMITS.passwordMin, `Пароль має містити щонайменше ${LIMITS.passwordMin} символів`)
  .max(LIMITS.passwordMax, "Пароль задовгий");

export const displayNameSchema = trimmed(LIMITS.displayName).min(1, "Вкажіть ім'я");

export const registerSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  password: passwordSchema,
  timeZone: z.string().refine(isValidTimeZone, "Невідомий часовий пояс").optional(),
});

export const loginSchema = z.object({
  username: z.string().trim().min(1, "Вкажіть ім'я користувача").max(64),
  password: z.string().min(1, "Вкажіть пароль").max(LIMITS.passwordMax),
});

const minuteOfDay = z.number().int().min(0).max(MINUTES_IN_DAY - 1);

export const updateMeSchema = z
  .object({
    displayName: displayNameSchema,
    username: usernameSchema,
    bio: trimmed(LIMITS.bio),
    timeZone: z.string().refine(isValidTimeZone, "Невідомий часовий пояс"),
    quietEnabled: z.boolean(),
    quietStart: minuteOfDay,
    quietEnd: minuteOfDay,
    showLocalTime: z.boolean(),
  })
  .partial()
  .strict();

export const messageTextSchema = z
  .string()
  .trim()
  .min(1, "Порожнє повідомлення")
  .max(LIMITS.messageText, `Не більше ${LIMITS.messageText} символів`);

export const sendMessageSchema = z.object({
  text: messageTextSchema,
  replyToId: z.number().int().positive().nullish(),
  delivery: z.enum(["gentle", "now"]).default("gentle"),
});

export const editMessageSchema = z.object({ text: messageTextSchema });

export const reactionSchema = z.object({ emoji: z.enum(REACTIONS).nullable() });

export const readSchema = z.object({ upTo: z.number().int().nonnegative() });

export const createPrivateSchema = z.object({ userId: z.number().int().positive() });

export const createGroupSchema = z.object({
  title: trimmed(LIMITS.groupTitle).min(1, "Вкажіть назву групи"),
  memberIds: z.array(z.number().int().positive()).min(1, "Додайте хоча б одного учасника").max(LIMITS.groupMembers),
});

export const chatSettingsSchema = z.object({ pinned: z.boolean(), muted: z.boolean() }).partial().strict();

export const deleteAccountSchema = z.object({ password: z.string().min(1, "Вкажіть пароль").max(LIMITS.passwordMax) });

/** First human-readable message from a zod error. */
export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Некоректні дані";
}
