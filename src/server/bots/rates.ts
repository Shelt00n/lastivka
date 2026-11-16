import { z } from "zod";
import type { JsonClient } from "./http";
import type { BotReply } from "./index";

/** National Bank of Ukraine official rates: public, no key. */
const NBU_URL = "https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json";

const nbuSchema = z.array(
  z.object({
    cc: z.string(),
    txt: z.string(),
    rate: z.number(),
    exchangedate: z.string(),
  }),
);
export type NbuRates = z.infer<typeof nbuSchema>;

const BUTTONS = ["Курси", "USD", "EUR", "100 USD", "1000 грн"];
const TOP = ["USD", "EUR", "PLN", "GBP", "CHF", "CZK", "JPY", "CNY"];

const ALIASES: Record<string, string> = {
  $: "USD", долар: "USD", долара: "USD", доларів: "USD", долари: "USD", дол: "USD", usd: "USD",
  "€": "EUR", євро: "EUR", eur: "EUR",
  злотий: "PLN", злотих: "PLN", злоті: "PLN", "zł": "PLN", pln: "PLN",
  фунт: "GBP", фунтів: "GBP", "£": "GBP", gbp: "GBP",
  франк: "CHF", франків: "CHF", chf: "CHF",
  єна: "JPY", єн: "JPY", jpy: "JPY",
  юань: "CNY", юанів: "CNY", cny: "CNY",
  грн: "UAH", гривня: "UAH", гривні: "UAH", гривень: "UAH", "₴": "UAH", uah: "UAH",
};

export type RatesQuery =
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "rate"; code: string }
  | { kind: "convert"; amount: number; from: string; to: string | null }
  | { kind: "unknown" };

function toCode(token: string): string | null {
  const t = token.toLowerCase();
  if (ALIASES[t]) return ALIASES[t]!;
  if (/^[a-z]{3}$/.test(t)) return t.toUpperCase();
  return null;
}

/** Pure parser — covered by unit tests. */
export function parseRatesQuery(input: string): RatesQuery {
  const text = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (!text || /^\/(start|help)/.test(text) || text === "допомога") return { kind: "help" };
  if (/^(\/rates|курси|курс|всі|все)$/.test(text)) return { kind: "list" };

  // "100 usd", "100$", "1 000,50 грн в eur", "250 євро"
  const conv = /^(\d[\d\s]*(?:[.,]\d+)?)\s*([^\s\d]+)(?:\s+(?:в|у|to|in|->)\s+([^\s]+))?$/.exec(text);
  if (conv) {
    const amount = Number(conv[1]!.replace(/\s/g, "").replace(",", "."));
    const from = toCode(conv[2]!);
    const to = conv[3] ? toCode(conv[3]) : null;
    if (!from || !Number.isFinite(amount) || amount <= 0 || amount > 1e12) return { kind: "unknown" };
    if (conv[3] && !to) return { kind: "unknown" };
    return { kind: "convert", amount, from, to };
  }

  const code = toCode(text.replace(/^\/rate\s*/, ""));
  if (code && code !== "UAH") return { kind: "rate", code };
  return { kind: "unknown" };
}

const fmt = (n: number, digits = 2) =>
  new Intl.NumberFormat("uk-UA", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);

/** Pure formatter/converter — covered by unit tests. */
export function answerRates(q: RatesQuery, rates: NbuRates): string {
  const byCode = new Map(rates.map((r) => [r.cc, r]));
  const date = rates[0]?.exchangedate ?? "";
  const rateOf = (code: string) => (code === "UAH" ? 1 : byCode.get(code)?.rate);

  switch (q.kind) {
    case "help":
    case "unknown":
      return "Курси НБУ 🏦\nНапишіть валюту (USD, євро) або суму для конвертації: «100 USD», «1000 грн в EUR».";
    case "list": {
      const lines = TOP.map((c) => byCode.get(c))
        .filter((r) => r !== undefined)
        .map((r) => `${r.cc}  ${fmt(r.rate, r.rate < 1 ? 4 : 2)} ₴`);
      return `Офіційні курси НБУ на ${date}:\n\n${lines.join("\n")}`;
    }
    case "rate": {
      const r = byCode.get(q.code);
      if (!r) return `Не знаю валюту ${q.code} 🤔`;
      return `1 ${r.cc} = ${fmt(r.rate, 4)} ₴\n${r.txt} · курс НБУ на ${date}`;
    }
    case "convert": {
      const from = rateOf(q.from);
      if (from === undefined) return `Не знаю валюту ${q.from} 🤔`;
      const targets = q.to ? [q.to] : q.from === "UAH" ? ["USD", "EUR"] : ["UAH"];
      const lines: string[] = [];
      for (const t of targets) {
        if (t === q.from) continue;
        const to = rateOf(t);
        if (to === undefined) return `Не знаю валюту ${t} 🤔`;
        lines.push(`${fmt(q.amount)} ${q.from} = ${fmt((q.amount * from) / to)} ${t}`);
      }
      if (lines.length === 0) return "Це та сама валюта 🙂";
      return `${lines.join("\n")}\nЗа курсом НБУ на ${date}`;
    }
  }
}

export const ratesWelcome: BotReply = {
  text: "Вітаю! Я знаю офіційні курси Національного банку 🏦\nНапишіть «USD», «Курси» або «100 USD».",
  buttons: BUTTONS,
};

export async function ratesBot(getJson: JsonClient, text: string): Promise<BotReply> {
  const q = parseRatesQuery(text);
  if (q.kind === "help") return ratesWelcome;
  const rates = await getJson("nbu", NBU_URL, nbuSchema, 30 * 60_000);
  return { text: answerRates(q, rates), buttons: BUTTONS };
}
