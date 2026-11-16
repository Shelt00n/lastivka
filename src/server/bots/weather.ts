import { z } from "zod";
import type { JsonClient } from "./http";
import type { BotReply } from "./index";

/** Open-Meteo: free, no API key. https://open-meteo.com */
const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

const CITIES = ["Київ", "Львів", "Одеса", "Харків"];

const geoSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        country: z.string().optional(),
        admin1: z.string().optional(),
      }),
    )
    .optional(),
});

const forecastSchema = z.object({
  current: z.object({
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

/** WMO weather interpretation codes → emoji + Ukrainian description. */
export function describeWeatherCode(code: number): [string, string] {
  if (code === 0) return ["☀️", "ясно"];
  if (code <= 2) return ["🌤", "мінлива хмарність"];
  if (code === 3) return ["☁️", "хмарно"];
  if (code === 45 || code === 48) return ["🌫", "туман"];
  if (code >= 51 && code <= 57) return ["🌦", "мряка"];
  if (code >= 61 && code <= 67) return ["🌧", "дощ"];
  if (code >= 71 && code <= 77) return ["🌨", "сніг"];
  if (code >= 80 && code <= 82) return ["🌧", "злива"];
  if (code === 85 || code === 86) return ["🌨", "снігопад"];
  if (code >= 95) return ["⛈", "гроза"];
  return ["🌡", "—"];
}

const signed = (t: number) => {
  const r = Math.round(t);
  return r > 0 ? `+${r}°` : `${r}°`;
};

const WEEKDAYS = ["Нд", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

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

export function formatForecast(place: string, f: Forecast): string {
  const [emoji, desc] = describeWeatherCode(f.current.weather_code);
  const lines = [
    `${emoji} ${place}: ${signed(f.current.temperature_2m)}, ${desc}`,
    `Відчувається як ${signed(f.current.apparent_temperature)} · вітер ${Math.round(f.current.wind_speed_10m)} м/с · вологість ${Math.round(f.current.relative_humidity_2m)}%`,
    "",
  ];
  f.daily.time.slice(0, 3).forEach((day, i) => {
    const [e] = describeWeatherCode(f.daily.weather_code[i] ?? 0);
    const label = i === 0 ? "Сьогодні" : i === 1 ? "Завтра" : WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()];
    lines.push(`${label}: ${e} ${signed(f.daily.temperature_2m_min[i] ?? 0)}…${signed(f.daily.temperature_2m_max[i] ?? 0)}`);
  });
  return lines.join("\n");
}

export const weatherWelcome: BotReply = {
  text: "Привіт! Я покажу погоду 🌤\nНапишіть назву міста — будь-якого у світі.",
  buttons: CITIES,
};

export async function weatherBot(getJson: JsonClient, text: string): Promise<BotReply> {
  if (/^\/(start|help)/i.test(text.trim())) return weatherWelcome;
  const city = parseCityQuery(text);
  if (!city) return { text: "Напишіть назву міста, наприклад: Київ", buttons: CITIES };

  const geo = await getJson(
    "open-meteo-geo",
    `${GEO_URL}?name=${encodeURIComponent(city)}&count=1&language=uk&format=json`,
    geoSchema,
    24 * 3600_000,
  );
  const place = geo.results?.[0];
  if (!place) return { text: `Не знайшла місто «${city}» 🤷 Спробуйте інакше.`, buttons: CITIES };

  const forecast = await getJson(
    "open-meteo",
    `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
      "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m" +
      "&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=3&wind_speed_unit=ms",
    forecastSchema,
    10 * 60_000,
  );
  const name = place.country ? `${place.name}, ${place.country}` : place.name;
  return { text: formatForecast(name, forecast), buttons: CITIES };
}
