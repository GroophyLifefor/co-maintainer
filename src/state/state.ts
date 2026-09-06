import type { State } from "../types.ts";

export function cacheRoot(repo: string): string {
  return `.cache/${repo}`;
}

export async function readState(repo: string): Promise<State | undefined> {
  try {
    return JSON.parse(
      await Deno.readTextFile(`${cacheRoot(repo)}/state.json`),
    ) as State;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

export async function writeState(state: State): Promise<void> {
  await Deno.mkdir(cacheRoot(state.repo), { recursive: true });
  await Deno.writeTextFile(
    `${cacheRoot(state.repo)}/state.json`,
    JSON.stringify(state, null, 2) + "\n",
  );
}
