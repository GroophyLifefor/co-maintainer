/** OpenRouter model prices for the probe estimate (CORE-24).
 *
 * `/api/v1/models` is public: no key needed. The list is large and changes
 * slowly, so it is cached for 24 hours in cache.db. A network failure is not
 * fatal — the estimate then reports tokens and time but no dollars, which is
 * still useful and never invents a price. */
import { openRouterBase } from "./verify.ts";
import { cacheGet, cacheSet } from "../store/cache_db.ts";

const CACHE_NAMESPACE = "pricing";
const CACHE_KEY = "openrouter/models";
const TTL_MS = 24 * 60 * 60 * 1_000;

/** USD per one million tokens. OpenRouter reports USD per single token. */
export type ModelPrice = { usdPerMillionIn: number; usdPerMillionOut: number };

export type PriceTable = {
  /** Model id -> price. A model OpenRouter does not list is simply absent. */
  prices: Map<string, ModelPrice>;
  /** Where the table came from, so the estimate can be honest about it. */
  source: "network" | "cache" | "unavailable";
};

function toPrice(row: unknown): ModelPrice | undefined {
  const pricing = (row as { pricing?: Record<string, unknown> } | null)
    ?.pricing;
  if (!pricing) return undefined;
  const inUsd = Number(pricing.prompt);
  const outUsd = Number(pricing.completion);
  if (!Number.isFinite(inUsd) || !Number.isFinite(outUsd)) return undefined;
  return {
    usdPerMillionIn: inUsd * 1_000_000,
    usdPerMillionOut: outUsd * 1_000_000,
  };
}

/** Fetches or reads the cached OpenRouter price list. Never throws: a failure
 * becomes `source: "unavailable"` so the caller degrades instead of failing. */
export async function loadPrices(): Promise<PriceTable> {
  let cached: string | undefined;
  try {
    cached = await cacheGet(CACHE_NAMESPACE, CACHE_KEY);
  } catch {
    cached = undefined;
  }
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as { at: string; rows: unknown[] };
      const age = Date.now() - new Date(parsed.at).getTime();
      if (age < TTL_MS) {
        return { prices: buildMap(parsed.rows), source: "cache" };
      }
    } catch {
      // A corrupt cache entry falls through to the network.
    }
  }
  try {
    const response = await fetch(`${openRouterBase()}/models`);
    if (!response.ok) return { prices: new Map(), source: "unavailable" };
    const body = (await response.json()) as { data?: unknown[] };
    const rows = Array.isArray(body.data) ? body.data : [];
    try {
      await cacheSet(
        CACHE_NAMESPACE,
        CACHE_KEY,
        JSON.stringify({ at: new Date().toISOString(), rows }),
      );
    } catch {
      // A cache write failure must not lose the freshly fetched prices.
    }
    return { prices: buildMap(rows), source: "network" };
  } catch {
    return { prices: new Map(), source: "unavailable" };
  }
}

function buildMap(rows: unknown[]): Map<string, ModelPrice> {
  const prices = new Map<string, ModelPrice>();
  for (const row of rows) {
    const id = (row as { id?: unknown } | null)?.id;
    if (typeof id !== "string") continue;
    const price = toPrice(row);
    if (price) prices.set(id, price);
  }
  return prices;
}
