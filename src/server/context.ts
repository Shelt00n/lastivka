import type { Db } from "./db";
import type { Hub } from "./services/hub";
import type { BotRegistry } from "./bots";

export interface AppContext {
  db: Db;
  hub: Hub;
  bots: BotRegistry;
  now: () => number;
  /** Fire-and-forget work (bot replies). Tests swap this to await it. */
  background: (task: Promise<unknown>) => void;
}

/** Same context, but every query goes through the given transaction. */
export const withDb = (ctx: AppContext, db: Db): AppContext => ({ ...ctx, db });

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = "Не знайдено") => new HttpError(404, what);
