import { createJsonClient, ExternalApiError, type FetchLike } from "./http";
import { weatherBot, weatherWelcome } from "./weather";
import { ratesBot, ratesWelcome } from "./rates";
import { wikiBot, wikiWelcome } from "./wiki";

export interface BotReply {
  text: string;
  buttons?: string[];
}

export interface BotRegistry {
  reply(kind: string, text: string): Promise<BotReply>;
  welcome(kind: string): BotReply;
}

export const BOT_ACCOUNTS = [
  { kind: "weather", username: "pogoda_bot", displayName: "Погода", bio: "Прогноз для будь-якого міста · дані Open-Meteo" },
  { kind: "rates", username: "nbu_rates_bot", displayName: "Курси НБУ", bio: "Офіційні курси валют Національного банку України" },
  { kind: "wiki", username: "wiki_bot", displayName: "Вікі", bio: "Коротка довідка з української Вікіпедії" },
] as const;

const FAILURE_TEXT: Record<ExternalApiError["reason"], string> = {
  timeout: "Сервіс відповідає занадто довго ⏳ Спробуйте ще раз за хвилину.",
  network: "Не вдалося зв'язатися із сервісом 📡 Спробуйте пізніше.",
  http: "Сервіс тимчасово недоступний 🛠 Спробуйте пізніше.",
  invalid: "Сервіс повернув незрозумілу відповідь 🤖 Спробуйте інший запит.",
};

export function createBots(fetchImpl: FetchLike = fetch): BotRegistry {
  const getJson = createJsonClient(fetchImpl);
  const handlers = { weather: weatherBot, rates: ratesBot, wiki: wikiBot } as const;
  const welcomes = { weather: weatherWelcome, rates: ratesWelcome, wiki: wikiWelcome } as const;

  return {
    async reply(kind, text) {
      const handler = handlers[kind as keyof typeof handlers];
      if (!handler) return { text: "Я поки не вмію відповідати 🙈" };
      try {
        return await handler(getJson, text);
      } catch (err) {
        if (err instanceof ExternalApiError) {
          console.warn(`[bot:${kind}] ${err.message}`);
          return { text: FAILURE_TEXT[err.reason] };
        }
        console.error(`[bot:${kind}]`, err);
        return { text: "Щось пішло не так 😕 Спробуйте ще раз." };
      }
    },
    welcome(kind) {
      return welcomes[kind as keyof typeof welcomes] ?? { text: "Привіт!" };
    },
  };
}
