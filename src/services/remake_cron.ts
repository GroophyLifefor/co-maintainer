import { readConfig } from "../config.ts";
import { getQueuedJobByKey, getRunningJobByKey } from "../store/jobs.ts";
import { listActiveRepos } from "../store/repos.ts";
import { cronMatches, parseCron } from "../util/cron.ts";
import type { Cron } from "../util/cron.ts";
import { enqueueSetup } from "./setup.ts";

/** A remake costs model tokens, so a schedule may fire at most once an hour. */
export function parseRemakeCron(expression: string): Cron {
  const cron = parseCron(expression);
  if (cron.minutes.size !== 1) {
    throw new Error(
      "the minute field must be a single value, so a remake runs at most once an hour",
    );
  }
  return cron;
}

/** Each minute is handled once however often the ticker is called. A minute
 * the process slept through is not made up. */
export function createRemakeCronTicker(): (now: Date) => string[] {
  let lastMinute = -1;
  return (now) => {
    const minute = Math.floor(now.getTime() / 60_000);
    if (minute === lastMinute) return [];
    lastMinute = minute;
    const config = readConfig();
    const queued: string[] = [];
    for (const repo of listActiveRepos()) {
      const expression = config.repos?.[repo.full_name]?.remakeCron;
      if (!expression || !repo.knowledge_built_at) continue;
      let cron: Cron;
      try {
        cron = parseRemakeCron(expression);
      } catch {
        continue;
      }
      if (!cronMatches(cron, now)) continue;
      const key = `setup:${repo.full_name}`;
      if (getQueuedJobByKey(key) || getRunningJobByKey(key)) continue;
      enqueueSetup(repo.full_name, "remake");
      queued.push(repo.full_name);
    }
    return queued;
  };
}

let timer: ReturnType<typeof setInterval> | undefined;

export function startRemakeScheduler(intervalMs = 15_000): void {
  if (timer !== undefined) return;
  const ticker = createRemakeCronTicker();
  timer = setInterval(() => {
    for (const repo of ticker(new Date())) {
      console.log(`[cron] queued a scheduled remake for ${repo}`);
    }
  }, intervalMs);
}

export function stopRemakeScheduler(): void {
  if (timer === undefined) return;
  clearInterval(timer);
  timer = undefined;
}
