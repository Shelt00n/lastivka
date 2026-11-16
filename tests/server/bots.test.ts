import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { answerRates, kyivDateParam, parseRatesQuery, ratesBot, type NbuRates } from "../../src/server/bots/rates";
import { cityCandidates, describeWeatherCode, formatForecast, parseCityQuery, weatherBot } from "../../src/server/bots/weather";
import { trimExtract, wikiBot } from "../../src/server/bots/wiki";
import { createJsonClient, ExternalApiError, type FetchLike } from "../../src/server/bots/http";
import { createBots } from "../../src/server/bots";

const norm = (s: string) => s.replace(/\s/g, " ");
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("rates bot: query parser", () => {
  it.each([
    ["/start", { kind: "help" }],
    ["Курси", { kind: "list" }],
    ["USD", { kind: "rate", code: "USD" }],
    ["євро", { kind: "rate", code: "EUR" }],
    ["100 USD", { kind: "convert", amount: 100, from: "USD", to: null }],
    ["100$", { kind: "convert", amount: 100, from: "USD", to: null }],
    ["1 000,50 грн в eur", { kind: "convert", amount: 1000.5, from: "UAH", to: "EUR" }],
    ["250 злотих", { kind: "convert", amount: 250, from: "PLN", to: null }],
    ["0 usd", { kind: "unknown" }],
    ["100 USD в банани", { kind: "unknown" }],
    ["як справи?", { kind: "unknown" }],
  ])("%s", (input, expected) => {
    expect(parseRatesQuery(input)).toEqual(expected);
  });
});

describe("rates bot: answers", () => {
  const rates: NbuRates = [
    { cc: "USD", txt: "Долар США", rate: 41.5, exchangedate: "16.11.2026" },
    { cc: "EUR", txt: "Євро", rate: 48, exchangedate: "16.11.2026" },
  ];

  it("converts foreign currency to hryvnia", () => {
    expect(norm(answerRates({ kind: "convert", amount: 100, from: "USD", to: null }, rates))).toContain(
      "100,00 USD = 4 150,00 UAH",
    );
  });

  it("converts hryvnia to USD and EUR by default", () => {
    const text = norm(answerRates({ kind: "convert", amount: 4800, from: "UAH", to: null }, rates));
    expect(text).toContain("4 800,00 UAH = 115,66 USD");
    expect(text).toContain("4 800,00 UAH = 100,00 EUR");
  });

  it("cross-converts between foreign currencies", () => {
    expect(norm(answerRates({ kind: "convert", amount: 48, from: "EUR", to: "USD" }, rates))).toContain(
      "48,00 EUR = 55,52 USD",
    );
  });

  it("reports unknown currencies instead of crashing", () => {
    expect(answerRates({ kind: "rate", code: "XYZ" }, rates)).toContain("Не знаю валюту XYZ");
  });
});

describe("weather bot", () => {
  it("extracts the city from free text", () => {
    expect(parseCityQuery("/weather Київ")).toBe("Київ");
    expect(parseCityQuery("погода у Львові?")).toBe("Львові");
    expect(parseCityQuery("   ")).toBeNull();
  });

  it("maps WMO codes", () => {
    expect(describeWeatherCode(0)).toEqual(["☀️", "ясно"]);
    expect(describeWeatherCode(63)[1]).toBe("дощ");
    expect(describeWeatherCode(95)[1]).toBe("гроза");
  });

  const forecast = {
    current: { temperature_2m: 3.4, apparent_temperature: -0.6, relative_humidity_2m: 81, weather_code: 3, wind_speed_10m: 4.2 },
    daily: {
      time: ["2026-11-16", "2026-11-17", "2026-11-18"],
      weather_code: [3, 61, 0],
      temperature_2m_max: [5, 4, 2],
      temperature_2m_min: [1, -1, -3],
    },
  };

  it("formats a forecast", () => {
    const text = formatForecast("Київ, Україна", forecast);
    expect(text).toContain("☁️ Київ, Україна: +3°, хмарно");
    expect(text).toContain("Відчувається як -1°");
    expect(text).toContain("Завтра: 🌧️ -1°…+4°");
    expect(text).toContain("Ср: ☀️ -3°…+2°");
  });

  it("calls geocoding then forecast and validates both responses", async () => {
    const fetchMock = vi.fn<FetchLike>(async (url) =>
      url.includes("geocoding")
        ? json({ results: [{ name: "Київ", latitude: 50.45, longitude: 30.52, country: "Україна" }] })
        : json(forecast),
    );
    const reply = await weatherBot(createJsonClient(fetchMock), "Київ");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toContain("latitude=50.45");
    expect(reply.text).toContain("Київ, Україна");
    expect(reply.buttons).toContain("Львів");
  });

  it("handles an unknown city", async () => {
    const reply = await weatherBot(createJsonClient(async () => json({})), "Блаблабург");
    expect(reply.text).toContain("Не знайшла місто «Блаблабург»");
  });
});

describe("wiki bot", () => {
  it("searches, then returns a trimmed summary with a link", async () => {
    const fetchMock: FetchLike = async (url) =>
      url.includes("opensearch")
        ? json(["Київ", ["Київ"], [""], ["https://uk.wikipedia.org/wiki/Київ"]])
        : json({ type: "standard", title: "Київ", extract: "Київ — столиця України.", content_urls: { mobile: { page: "https://uk.m.wikipedia.org/wiki/Київ" } } });
    const reply = await wikiBot(createJsonClient(fetchMock), "київ");
    expect(reply.text).toBe("📖 Київ\n\nКиїв — столиця України.\n\nhttps://uk.m.wikipedia.org/wiki/Київ");
  });

  it("trims long extracts at a sentence boundary", () => {
    const long = "Перше речення. ".repeat(80);
    const out = trimExtract(long, 100);
    expect(out.length).toBeLessThanOrEqual(102);
    expect(out.endsWith(". …")).toBe(true);
  });
});

describe("external API client", () => {
  const schema = z.object({ ok: z.boolean() });

  it("caches responses within TTL", async () => {
    let now = 0;
    const fetchMock = vi.fn<FetchLike>(async () => json({ ok: true }));
    const get = createJsonClient(fetchMock, { now: () => now });
    await get("svc", "https://x/a", schema, 1000);
    await get("svc", "https://x/a", schema, 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now = 1001;
    await get("svc", "https://x/a", schema, 1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("times out slow APIs", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)));
    const get = createJsonClient(hang, { timeoutMs: 20 });
    await expect(get("svc", "https://x", schema, 0)).rejects.toMatchObject({ reason: "timeout" });
  });

  it("rejects HTTP errors and unexpected shapes", async () => {
    await expect(createJsonClient(async () => json({}, 503))("svc", "https://x", schema, 0)).rejects.toMatchObject({
      reason: "http",
    });
    await expect(createJsonClient(async () => json({ ok: "yes" }))("svc", "https://x", schema, 0)).rejects.toBeInstanceOf(
      ExternalApiError,
    );
  });

  it("bots turn API failures into a friendly message", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bots = createBots(async () => {
      throw new TypeError("fetch failed");
    });
    const reply = await bots.reply("weather", "Київ");
    expect(reply.text).toContain("Не вдалося зв'язатися із сервісом");
  });
});

describe("bot reliability and fresh data", () => {
  const forecast = {
    current: { time: "2026-11-16T19:15", temperature_2m: 5.3, apparent_temperature: 1.2, relative_humidity_2m: 72, weather_code: 3, wind_speed_10m: 3.8 },
    daily: { time: ["2026-11-16", "2026-11-17", "2026-11-18"], weather_code: [3, 80, 61], temperature_2m_max: [5.7, 4.9, 7.8], temperature_2m_min: [-0.5, 2.8, 4.7] },
  };
  const geo = { results: [{ name: "Київ", latitude: 50.4547, longitude: 30.5238, country: "Україна", timezone: "Europe/Kyiv" }] };
  // 18:00Z on Nov 16 = 20:00 in Kyiv
  const NOW = Date.UTC(2026, 10, 16, 18, 0);
  const metno = {
    properties: {
      meta: { updated_at: "2026-11-16T17:19:41Z" },
      timeseries: [
        { time: "2026-11-16T18:00:00Z", data: { instant: { details: { air_temperature: 5.7, relative_humidity: 73.8, wind_speed: 6.1 } }, next_1_hours: { summary: { symbol_code: "cloudy" } }, next_6_hours: { summary: { symbol_code: "cloudy" } } } },
        { time: "2026-11-17T09:00:00Z", data: { instant: { details: { air_temperature: 3.1 } }, next_6_hours: { summary: { symbol_code: "lightrain" } } } },
        { time: "2026-11-17T12:00:00Z", data: { instant: { details: { air_temperature: 6.4 } } } },
        { time: "2026-11-18T10:00:00Z", data: { instant: { details: { air_temperature: 8.0 } }, next_6_hours: { summary: { symbol_code: "clearsky_day" } } } },
      ],
    },
  };

  it("shows when the weather data is for", async () => {
    const fetchMock: FetchLike = async (url) => (url.includes("geocoding") ? json(geo) : json(forecast));
    const reply = await weatherBot(createJsonClient(fetchMock, { retryDelayMs: 0 }), "Київ", NOW);
    expect(reply.text).toContain("Дані Open-Meteo на 19:15 за місцевим часом");
  });

  it("falls back to MET Norway when Open-Meteo refuses (e.g. per-IP limit on shared hosting)", async () => {
    const calls: string[] = [];
    const fetchMock: FetchLike = async (url) => {
      calls.push(url);
      if (url.includes("geocoding")) return json(geo);
      if (url.includes("//api.open-meteo.com")) return json({ reason: "limit" }, 429);
      return json(metno);
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const reply = await weatherBot(createJsonClient(fetchMock, { retryDelayMs: 0 }), "Київ", NOW);
    expect(calls.filter((u) => u.includes("//api.open-meteo.com"))).toHaveLength(2); // one retry
    expect(calls.some((u) => u.includes("api.met.no"))).toBe(true);
    expect(reply.text).toContain("☁️ Київ, Україна: +6°, хмарно");
    expect(reply.text).toContain("Завтра: 🌧️ +3°…+6°");
    expect(reply.text).toContain("Дані MET Norway на 19:19 за місцевим часом");
  });

  it("understands cities in the locative case", async () => {
    expect(cityCandidates("Харкові")).toContain("Харків");
    expect(cityCandidates("Львові")).toContain("Львів");
    expect(cityCandidates("Києві")).toContain("Київ");
    expect(cityCandidates("Одесі")).toContain("Одеса");
    const asked: string[] = [];
    const fetchMock: FetchLike = async (url) => {
      if (url.includes("geocoding")) {
        const name = decodeURIComponent(new URL(url).searchParams.get("name")!);
        asked.push(name);
        return json(name === "Харків" ? { results: [{ name: "Харків", latitude: 49.99, longitude: 36.23, country: "Україна" }] } : {});
      }
      return json(forecast);
    };
    const reply = await weatherBot(createJsonClient(fetchMock, { retryDelayMs: 0 }), "погода у Харкові", NOW);
    expect(asked.slice(0, 2)).toEqual(["Харкові", "Харків"]);
    expect(reply.text).toContain("Харків, Україна");
  });

  it("retries a transient failure once, but not a client error", async () => {
    let n = 0;
    const flaky = createJsonClient(async () => (++n === 1 ? json({}, 503) : json({ ok: true })), { retryDelayMs: 0 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(flaky("svc", "https://x/flaky", z.object({ ok: z.boolean() }), 0)).resolves.toEqual({ ok: true });
    expect(n).toBe(2);

    let m = 0;
    const notFound = createJsonClient(async () => (++m, json({}, 404)), { retryDelayMs: 0 });
    await expect(notFound("svc", "https://x/404", z.object({ ok: z.boolean() }), 0)).rejects.toMatchObject({ reason: "http" });
    expect(m).toBe(1);
  });

  it("asks NBU for today's rate (Kyiv date) and mentions tomorrow's when already set", async () => {
    expect(kyivDateParam(Date.UTC(2026, 10, 16, 22, 30))).toBe("20261117"); // 00:30 in Kyiv
    const urls: string[] = [];
    const fetchMock: FetchLike = async (url) => {
      urls.push(url);
      return url.includes("date=")
        ? json([{ cc: "USD", txt: "Долар США", rate: 45.4274, exchangedate: "16.11.2026" }])
        : json([{ cc: "USD", txt: "Долар США", rate: 45.3918, exchangedate: "17.11.2026" }]);
    };
    const reply = await ratesBot(createJsonClient(fetchMock, { retryDelayMs: 0 }), "USD", NOW);
    expect(urls[0]).toContain("date=20261116");
    const text = norm(reply.text);
    expect(text).toContain("1 USD = 45,4274 ₴");
    expect(text).toContain("офіційний курс НБУ на 16.11.2026");
    expect(text).toContain("З 17.11.2026: 45,3918 ₴ (−0,0356)");
  });
});
