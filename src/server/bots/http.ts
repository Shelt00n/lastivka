import type { z } from "zod";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ExternalApiError extends Error {
  constructor(
    readonly service: string,
    readonly reason: "timeout" | "http" | "network" | "invalid",
    detail?: string,
  ) {
    super(`${service}: ${reason}${detail ? ` (${detail})` : ""}`);
  }
}

interface Options {
  timeoutMs?: number;
  now?: () => number;
  maxEntries?: number;
  retryDelayMs?: number;
}

/**
 * Small JSON client for third-party APIs:
 *  - hard timeout (a slow API must never hang a chat),
 *  - TTL cache (rates change daily, weather every ~15 min — don't hammer free APIs),
 *  - zod validation (external data is untrusted input).
 */
export function createJsonClient(fetchImpl: FetchLike, opts: Options = {}) {
  const { timeoutMs = 5000, now = Date.now, maxEntries = 500, retryDelayMs = 400 } = opts;
  const cache = new Map<string, { expires: number; value: unknown }>();

  async function fetchOnce<T>(service: string, url: string, schema: z.ZodType<T>): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: "application/json", "User-Agent": "Lastivka/1.0 (demo messenger)" },
      });
    } catch (err) {
      const name = (err as Error)?.name;
      throw new ExternalApiError(service, name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
    }
    if (!res.ok) throw new ExternalApiError(service, "http", String(res.status));

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ExternalApiError(service, "invalid", "not json");
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ExternalApiError(service, "invalid", parsed.error.issues[0]?.message);
    return parsed.data;
  }

  /** Worth one more try: network hiccup, timeout, rate limit or a server error. */
  const transient = (e: ExternalApiError) =>
    e.reason === "timeout" || e.reason === "network" || (e.reason === "http" && /^(429|5\d\d)/.test(e.message.split("(")[1] ?? ""));

  return async function getJson<T>(service: string, url: string, schema: z.ZodType<T>, ttlMs: number): Promise<T> {
    const hit = cache.get(url);
    if (hit && hit.expires > now()) return hit.value as T;

    let value: T;
    try {
      value = await fetchOnce(service, url, schema);
    } catch (err) {
      if (!(err instanceof ExternalApiError) || !transient(err)) throw err;
      console.warn(`[external] ${err.message} — retrying once`);
      await new Promise((r) => setTimeout(r, retryDelayMs));
      value = await fetchOnce(service, url, schema);
    }

    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value!);
    cache.set(url, { expires: now() + ttlMs, value });
    return value;
  };
}

export type JsonClient = ReturnType<typeof createJsonClient>;
