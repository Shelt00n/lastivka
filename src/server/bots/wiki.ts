import { z } from "zod";
import type { JsonClient } from "./http";
import type { BotReply } from "./index";

/** Ukrainian Wikipedia: public REST + Action API, no key. */
const SEARCH_URL = "https://uk.wikipedia.org/w/api.php?action=opensearch&limit=1&namespace=0&format=json&search=";
const SUMMARY_URL = "https://uk.wikipedia.org/api/rest_v1/page/summary/";

const searchSchema = z.tuple([z.string(), z.array(z.string()), z.array(z.string()), z.array(z.string())]);

const summarySchema = z.object({
  type: z.string(),
  title: z.string(),
  extract: z.string().default(""),
  content_urls: z.object({ mobile: z.object({ page: z.string() }) }).optional(),
});

const SUGGESTIONS = ["Київ", "Тарас Шевченко", "Ластівка"];
const MAX_EXTRACT = 700;

export function trimExtract(text: string, max = MAX_EXTRACT): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastStop = cut.lastIndexOf(". ");
  return (lastStop > max * 0.5 ? cut.slice(0, lastStop + 1) : cut.trimEnd()) + " …";
}

export const wikiWelcome: BotReply = {
  text: "Я шукаю у Вікіпедії 📚\nНапишіть будь-яке слово чи ім'я — надішлю коротку довідку.",
  buttons: SUGGESTIONS,
};

export async function wikiBot(getJson: JsonClient, text: string): Promise<BotReply> {
  const query = text.trim().replace(/^\/wiki(@\w+)?\s*/i, "");
  if (!query || /^\/(start|help)/i.test(query)) return wikiWelcome;
  if (query.length > 100) return { text: "Запит задовгий — спробуйте коротше." };

  const [, titles] = await getJson("wikipedia-search", SEARCH_URL + encodeURIComponent(query), searchSchema, 3600_000);
  const title = titles[0];
  if (!title) return { text: `Нічого не знайшла за запитом «${query}» 🤷`, buttons: SUGGESTIONS };

  const page = await getJson(
    "wikipedia",
    SUMMARY_URL + encodeURIComponent(title.replace(/ /g, "_")),
    summarySchema,
    3600_000,
  );
  if (page.type === "disambiguation") {
    return { text: `«${page.title}» має кілька значень. Уточніть запит, будь ласка.` };
  }
  const url = page.content_urls?.mobile.page;
  return { text: `📖 ${page.title}\n\n${trimExtract(page.extract)}${url ? `\n\n${url}` : ""}` };
}
