import type { State } from "../knowledge/types.ts";
import { cacheGet, cacheSet } from "./cache_db.ts";

export async function readState(repo: string): Promise<State | undefined> {
  const value = await cacheGet("state", repo);
  if (value) return JSON.parse(value) as State;
  try {
    const legacy = JSON.parse(
      await Deno.readTextFile(`.cache/${repo}/state.json`),
    ) as State & { options: State["options"] & { maxPrYears?: number } };
    if (
      legacy.options.maxPrMonths === undefined &&
      legacy.options.maxPrYears !== undefined
    ) {
      legacy.options.maxPrMonths = legacy.options.maxPrYears * 12;
    }
    await writeState(legacy);
    return legacy;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

export async function writeState(state: State): Promise<void> {
  await cacheSet("state", state.repo, JSON.stringify(state));
}
