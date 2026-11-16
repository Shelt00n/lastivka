import { z } from "zod";
import { ExternalApiError, type JsonClient } from "./http";
import type { BotReply } from "./index";
import { zonedParts } from "../../shared/quietHours";

/**
 * Weather bot.
 *  - geocoding: Open-Meteo (free, no key);
 *  - forecast: Open-Meteo, with MET Norway (api.met.no, free, no key) as a fallback —
 *    shared hosting IPs sometimes hit Open-Meteo's per-IP limit, and the bot must still answer.
 * Every answer says what moment the data is for.
 */
const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const METNO_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact";

const CITIES = ["Київ", "Львів", "Одеса", "Харків"];
const FORECAST_TTL = 10 * 60_000;

const geoSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        country: z.string().optional(),
        timezone: z.string().optional(),
      }),
    )
    .optional(),
});
type Place = NonNullable<z.infer<typeof geoSchema>["results"]>[number];

const forecastSchema = z.object({
  current: z.object({
    time: z.string().optional(),
    temperature_2m: z.number(),
    apparent_temperature: z.number(),
    relative_humidity_2m: z.number(),
    weather_code: z.number(),
    wind_speed_10m: z.number(),
  }),
  daily: z.object({
    time: z.array(z.string()),
    weather_code: z.array(z.number()),
    temperature_2m_max: z.array(z.number()),
    temperature_2m_min: z.array(z.number()),
  }),
});
export type Forecast = z.infer<typeof forecastSchema>;

const metnoSchema = z.object({
  properties: z.object({
    meta: z.object({ updated_at: z.string() }).optional(),
    timeseries: z
      .array(
        z.object({
          time: z.string(),
          data: z.object({
            instant: z.object({
              details: z.object({
                air_temperature: z.number(),
                relative_humidity: z.number().optional(),
                wind_speed: z.number().optional(),
              }),
            }),
            next_1_hours: z.object({ summary: z.object({ symbol_code: z.string() }) }).optional(),
            next_6_hours: z.object({ summary: z.object({ symbol_code: z.string() }) }).optional(),
          }),
        }),
      )
      .min(1),
  }),
});
export type MetNoForecast = z.infer<typeof metnoSchema>;

/** One shape for both providers. */
export interface Weather {
  temp: number;
  feels: number | null;
  humidity: number | null;
  wind: number | null;
  look: [string, string];
  /** Local wall time the "now" values are for, "19:15". */
  asOf: string | null;
  days: { date: string; look: [string, string]; min: number; max: number }[];
  source: string;
}

/** WMO weather interpretation codes → emoji + Ukrainian description. */
export function describeWeatherCode(code: number): [string, string] {
  if (code === 0) return ["☀️", "ясно"];
  if (code <= 2) return ["🌤️", "мінлива хмарність"];
  if (code === 3) return ["☁️", "хмарно"];
  if (code === 45 || code === 48) return ["🌫️", "туман"];
  if (code >= 51 && code <= 57) return ["🌦️", "мряка"];
  if (code >= 61 && code <= 67) return ["🌧️", "дощ"];
  if (code >= 71 && code <= 77) return ["🌨️", "сніг"];
  if (code >= 80 && code <= 82) return ["🌧️", "злива"];
  if (code === 85 || code === 86) return ["🌨️", "снігопад"];
  if (code >= 95) return ["⛈️", "гроза"];
  return ["🌡️", "—"];
}

/** MET Norway symbol codes ("lightrainshowers_day") → emoji + Ukrainian description. */
export function describeSymbol(symbol: string): [string, string] {
  const s = symbol.replace(/_(day|night|polartwilight)$/, "");
  if (s.includes("thunder")) return ["⛈️", "гроза"];
  if (s.includes("sleet")) return ["🌨️", "мокрий сніг"];
  if (s.includes("snow")) return ["🌨️", "сніг"];
  if (s.includes("rainshowers")) return ["🌧️", "злива"];
  if (s.includes("rain")) return ["🌧️", "дощ"];
  if (s === "fog") return ["🌫️", "туман"];
  if (s === "clearsky") return ["☀️", "ясно"];
  if (s === "fair" || s === "partlycloudy") return ["🌤️", "мінлива хмарність"];
  if (s === "cloudy") return ["☁️", "хмарно"];
  return ["🌡️", "—"];
}

/** Wind chill (Environment Canada) for cold, windy weather; null when it doesn't apply. */
export function windChill(tempC: number, windMs: number | undefined): number | null {
  if (windMs === undefined) return null;
  const kmh = windMs * 3.6;
  if (tempC > 10 || kmh < 4.8) return null;
  const v = kmh ** 0.16;
  return 13.12 + 0.6215 * tempC - 11.37 * v + 0.3965 * tempC * v;
}

const hhmm = (iso: string) => iso.slice(11, 16);
const pad = (n: number) => String(n).padStart(2, "0");

export function fromOpenMeteo(f: Forecast): Weather {
  return {
    temp: f.current.temperature_2m,
    feels: f.current.apparent_temperature,
    humidity: f.current.relative_humidity_2m,
    wind: f.current.wind_speed_10m,
    look: describeWeatherCode(f.current.weather_code),
    asOf: f.current.time ? hhmm(f.current.time) : null,
    days: f.daily.time.slice(0, 3).map((date, i) => ({
      date,
      look: describeWeatherCode(f.daily.weather_code[i] ?? 0),
      min: f.daily.temperature_2m_min[i] ?? 0,
      max: f.daily.temperature_2m_max[i] ?? 0,
    })),
    source: "Open-Meteo",
  };
}

export function fromMetNo(f: MetNoForecast, timeZone: string, now = Date.now()): Weather {
  const series = f.properties.timeseries;
  // "Now" = the latest step that has already started.
  const current = [...series].reverse().find((s) => Date.parse(s.time) <= now) ?? series[0]!;
  const d = current.data.instant.details;
  const symbol = current.data.next_1_hours?.summary.symbol_code ?? current.data.next_6_hours?.summary.symbol_code ?? "";
  const local = (iso: string) => {
    const p = zonedParts(Date.parse(iso), timeZone);
    return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, hour: p.hour, clock: `${pad(p.hour)}:${pad(p.minute)}` };
  };

  const byDate = new Map<string, { min: number; max: number; symbol: string | null; symbolHourGap: number }>();
  for (const s of series) {
    const { date, hour } = local(s.time);
    const t = s.data.instant.details.air_temperature;
    const day = byDate.get(date) ?? { min: t, max: t, symbol: null, symbolHourGap: 99 };
    day.min = Math.min(day.min, t);
    day.max = Math.max(day.max, t);
    // The day's picture = the 6-hour summary closest to midday.
    const sym = s.data.next_6_hours?.summary.symbol_code;
    if (sym && Math.abs(hour - 12) < day.symbolHourGap) {
      day.symbol = sym;
      day.symbolHourGap = Math.abs(hour - 12);
    }
    byDate.set(date, day);
  }
  const today = local(new Date(now).toISOString()).date;
  const days = [...byDate.entries()]
    .filter(([date]) => date >= today)
    .slice(0, 3)
    .map(([date, v]) => ({ date, look: describeSymbol(v.symbol ?? symbol), min: v.min, max: v.max }));

  return {
    temp: d.air_temperature,
    feels: windChill(d.air_temperature, d.wind_speed),
    humidity: d.relative_humidity ?? null,
    wind: d.wind_speed ?? null,
    look: describeSymbol(symbol),
    asOf: f.properties.meta ? local(f.properties.meta.updated_at).clock : local(current.time).clock,
    days,
    source: "MET Norway",
  };
}

const signed = (t: number) => {
  const r = Math.round(t);
  return r > 0 ? `+${r}°` : `${r}°`;
};

const WEEKDAYS = ["Нд", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

export function formatWeather(place: string, w: Weather): string {
  const [emoji, desc] = w.look;
  const details = [
    w.feels !== null && Math.round(w.feels) !== Math.round(w.temp) ? `відчувається як ${signed(w.feels)}` : null,
    w.wind !== null ? `вітер ${Math.round(w.wind)} м/с` : null,
    w.humidity !== null ? `вологість ${Math.round(w.humidity)}%` : null,
  ].filter(Boolean);
  const lines = [`${emoji} ${place}: ${signed(w.temp)}, ${desc}`];
  if (details.length) lines.push(details.join(" · ").replace(/^./, (c) => c.toUpperCase()));
  lines.push("");
  w.days.forEach((day, i) => {
    const label = i === 0 ? "Сьогодні" : i === 1 ? "Завтра" : WEEKDAYS[new Date(`${day.date}T12:00:00Z`).getUTCDay()];
    const range = Math.round(day.min) === Math.round(day.max) ? signed(day.max) : `${signed(day.min)}…${signed(day.max)}`;
    lines.push(`${label}: ${day.look[0]} ${range}`);
  });
  lines.push("", `Дані ${w.source}${w.asOf ? ` на ${w.asOf} за місцевим часом` : ""}`);
  return lines.join("\n");
}

/** Kept for callers/tests that format raw Open-Meteo data. */
export const formatForecast = (place: string, f: Forecast) => formatWeather(place, fromOpenMeteo(f));

/** Extract a city from free text: "/weather Київ", "погода у Львові", "Одеса". */
export function parseCityQuery(text: string): string | null {
  const cleaned = text
    .trim()
    .replace(/^\/(weather|pogoda)(@\w+)?/i, "")
    .replace(/^погода\s*/i, "")
    .replace(/^(в|у|для)\s+/i, "")
    .replace(/[?!.]+$/, "")
    .trim();
  if (!cleaned || cleaned.length > 60) return null;
  return cleaned;
}

/** "у Львові" → also try "Львів": Ukrainian locative/dative endings back to the dictionary form. */
export function cityCandidates(city: string): string[] {
  const out = [city];
  const add = (v: string) => v.length >= 2 && !out.includes(v) && out.push(v);
  if (/ові$/i.test(city)) add(city.replace(/ові$/i, "ів"));
  if (/єві$/i.test(city)) add(city.replace(/єві$/i, "їв"));
  if (/еві$/i.test(city)) add(city.replace(/еві$/i, "ів"));
  if (/і$/i.test(city)) {
    add(city.replace(/і$/i, "а"));
    add(city.replace(/і$/i, "о"));
    add(city.replace(/і$/i, ""));
  }
  return out.slice(0, 4);
}

export const weatherWelcome: BotReply = {
  text: "Привіт! Я покажу погоду 🌤️\nНапишіть назву міста — будь-якого у світі.",
  buttons: CITIES,
};

async function geocode(getJson: JsonClient, city: string): Promise<Place | null> {
  for (const name of cityCandidates(city)) {
    const geo = await getJson(
      "open-meteo-geo",
      `${GEO_URL}?name=${encodeURIComponent(name)}&count=1&language=uk&format=json`,
      geoSchema,
      24 * 3600_000,
    );
    if (geo.results?.[0]) return geo.results[0];
  }
  return null;
}

export async function weatherBot(getJson: JsonClient, text: string, now = Date.now()): Promise<BotReply> {
  if (/^\/(start|help)/i.test(text.trim())) return weatherWelcome;
  const city = parseCityQuery(text);
  if (!city) return { text: "Напишіть назву міста, наприклад: Київ", buttons: CITIES };

  const place = await geocode(getJson, city);
  if (!place) return { text: `Не знайшла місто «${city}» 🤷 Спробуйте інакше.`, buttons: CITIES };

  const lat = place.latitude.toFixed(4);
  const lon = place.longitude.toFixed(4);
  let weather: Weather;
  try {
    const f = await getJson(
      "open-meteo",
      `${FORECAST_URL}?latitude=${lat}&longitude=${lon}` +
        "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m" +
        "&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=3&wind_speed_unit=ms",
      forecastSchema,
      FORECAST_TTL,
    );
    weather = fromOpenMeteo(f);
  } catch (err) {
    if (!(err instanceof ExternalApiError)) throw err;
    console.warn(`[bot:weather] ${err.message} — falling back to MET Norway`);
    const f = await getJson("met-norway", `${METNO_URL}?lat=${lat}&lon=${lon}`, metnoSchema, FORECAST_TTL);
    weather = fromMetNo(f, place.timezone ?? "UTC", now);
  }
  const name = place.country ? `${place.name}, ${place.country}` : place.name;
  return { text: formatWeather(name, weather), buttons: CITIES };
}
