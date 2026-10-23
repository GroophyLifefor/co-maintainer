import { cacheGet, cacheSet } from "../store/cache_db.ts";
import type { AiProvider, AiRequest, AiResponse } from "../types.ts";
import { isNotFound, readTextFile } from "../util/runtime.ts";
import { formatError } from "../cli/error.ts";

type JobRecord = {
  status: "done" | "quarantine";
  response?: AiResponse;
  error?: string;
  updatedAt: string;
};

type JobCache = Record<string, JobRecord>;
type UsageSink = (job: string, response: AiResponse) => Promise<void>;

/** Returns `null` when a response is usable, or a short reason when it is not.
 * `synthesis.ts` supplies one that parses the model text, because a syntactically
 * fine HTTP response can still be unparseable output, and caching that is what
 * poisoned every later `sync`. */
export type AiValidator = (
  request: AiRequest,
  response: AiResponse,
) => string | null;

/** A provider call and an unusable response are both retried this many times
 * before the batch gives up and the run fails. */
export const MAX_ATTEMPTS = 3;

/** A rate-limited unit gets more tries than a broken one. The provider needs a
 * window to recover, and giving up after three fast retries fails a run that
 * would have gone through a minute later. Only `429`/`rate limit` failures use
 * this bound. */
export const MAX_RATE_LIMIT_ATTEMPTS = 6;
const RATE_LIMIT_BACKOFF_MS = [5_000, 15_000, 30_000, 45_000, 60_000];

/** True when a failure is the provider throttling, not a broken request. */
export function isRateLimit(reason: string): boolean {
  return /429|rate limit/i.test(reason);
}

/** How long to wait before the next attempt. Zero unless the failure is a rate
 * limit, so every other failure retries immediately. Exported so the schedule
 * can be tested without waiting on it. */
export function retryDelayMs(reason: string, attempt: number): number {
  if (!isRateLimit(reason)) return 0;
  return RATE_LIMIT_BACKOFF_MS[
    Math.min(attempt - 1, RATE_LIMIT_BACKOFF_MS.length - 1)
  ]!;
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class AiBatch {
  private records: JobCache = {};
  private loaded = false;
  private saveChain = Promise.resolve();
  private readonly provider: AiProvider;
  private readonly repo: string;
  private readonly concurrency: number;
  private readonly profile: string;
  private readonly validate?: AiValidator;

  constructor(
    provider: AiProvider,
    repo: string,
    concurrency: number,
    profile: string,
    validate?: AiValidator,
  ) {
    this.provider = provider;
    this.repo = repo;
    this.concurrency = concurrency;
    this.profile = profile;
    this.validate = validate;
  }

  async run(
    requests: AiRequest[],
    usage?: UsageSink,
  ): Promise<(AiResponse | undefined)[]> {
    await this.load();
    const results: (AiResponse | undefined)[] = new Array(requests.length);
    const pending: { index: number; id: string; request: AiRequest }[] = [];

    for (let index = 0; index < requests.length; index++) {
      const request = requests[index];
      const id = await digest(
        JSON.stringify({
          profile: this.profile,
          job: request.job,
          system: request.system,
          prompt: request.prompt,
          maxTokens: request.maxTokens,
        }),
      );
      const cached = this.records[id];
      if (cached?.status === "done" && cached.response) {
        // A `done` record from 0.4.x can hold output that never parsed. Treat
        // that as a miss and delete it so the retry below replaces it; the
        // corrupted record heals on its own the next time its unit runs.
        const reason = this.validate?.(request, cached.response) ?? null;
        if (reason === null) {
          results[index] = cached.response;
          console.log(`[ai] cache hit ${request.job} ${id.slice(0, 8)}`);
        } else {
          delete this.records[id];
          await this.persist();
          console.log(
            `[ai] dropped unusable cache record ${request.job} ${id.slice(0, 8)}: ${reason}`,
          );
          pending.push({ index, id, request });
        }
      } else if (cached?.status === "quarantine") {
        // A provider error from an earlier run is not a permanent verdict: drop
        // the record and try again rather than skipping it forever.
        delete this.records[id];
        await this.persist();
        pending.push({ index, id, request });
      } else {
        pending.push({ index, id, request });
      }
    }

    let cursor = 0;
    console.log(
      `[ai] queue ${requests.length} jobs · ${pending.length} pending · concurrency ${this.concurrency}`,
    );
    const worker = async () => {
      while (cursor < pending.length) {
        const item = pending[cursor++];
        const startedAt = Date.now();
        console.log(`[ai] start ${item.request.job} ${item.id.slice(0, 8)}`);
        const heartbeat = setInterval(() => {
          const seconds = Math.round((Date.now() - startedAt) / 1000);
          console.log(
            `[ai] still running ${item.request.job} ${item.id.slice(0, 8)} · ${seconds}s`,
          );
        }, 15_000);
        try {
          await this.completeUnit(item, results, usage, startedAt);
        } finally {
          clearInterval(heartbeat);
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(this.concurrency, Math.max(1, pending.length)) },
        () => worker(),
      ),
    );
    await this.saveChain;
    return results;
  }

  /** Runs one unit, retrying a provider error and a response the validator
   * rejects. It never throws: a provider error that outlives its retries drops
   * the unit, and a response that still does not validate is used anyway. A run
   * that has already paid for extraction must still write what it has; a format
   * deviation is not worth losing the whole run over. */
  private async completeUnit(
    item: { index: number; id: string; request: AiRequest },
    results: (AiResponse | undefined)[],
    usage: UsageSink | undefined,
    startedAt: number,
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      let response: AiResponse;
      try {
        response = await this.provider.complete(item.request);
      } catch (error) {
        const reason = formatError(error);
        const limit = isRateLimit(reason)
          ? MAX_RATE_LIMIT_ATTEMPTS
          : MAX_ATTEMPTS;
        console.log(
          `[ai] call failed ${attempt}/${limit} ${item.request.job} ${item.id.slice(0, 8)}: ${reason}`,
        );
        if (attempt < limit) {
          const wait = retryDelayMs(reason, attempt);
          if (wait > 0) {
            console.log(
              `[ai] waiting ${Math.round(wait / 1000)}s before retry (provider is rate limiting)`,
            );
            await new Promise((resolve) => setTimeout(resolve, wait));
          }
          continue;
        }
        console.log(
          `[ai] gave up ${item.request.job} ${item.id.slice(0, 8)} after ${attempt} attempts; continuing without it`,
        );
        return;
      }
      const reason = this.validate?.(item.request, response) ?? null;
      if (reason !== null && attempt < MAX_ATTEMPTS) {
        console.log(
          `[ai] output rejected ${attempt}/${MAX_ATTEMPTS} ${item.request.job} ${item.id.slice(0, 8)}: ${reason}`,
        );
        continue;
      }
      if (reason !== null) {
        console.log(
          `[ai] using output that did not validate ${item.request.job} ${item.id.slice(0, 8)}: ${reason}`,
        );
      }
      this.records[item.id] = {
        status: "done",
        response,
        updatedAt: new Date().toISOString(),
      };
      results[item.index] = response;
      await this.persist();
      if (usage) await usage(item.request.job, response);
      console.log(
        `[ai] ${attempt === 1 ? "done" : `retried (${attempt})`} ${item.request.job} ${item.id.slice(0, 8)} · ${Math.round(
          (Date.now() - startedAt) / 1000,
        )}s`,
      );
      return;
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const key = `${this.repo}:${this.profile}`;
    const cached = await cacheGet("ai-jobs", key);
    if (cached) {
      this.records = JSON.parse(cached) as JobCache;
      this.loaded = true;
      return;
    }
    try {
      this.records = JSON.parse(
        await readTextFile(`.cache/${this.repo}/ai-jobs.json`),
      ) as JobCache;
      await cacheSet("ai-jobs", key, JSON.stringify(this.records));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.records, null, 2) + "\n";
    this.saveChain = this.saveChain.then(async () => {
      await cacheSet("ai-jobs", `${this.repo}:${this.profile}`, snapshot);
    });
    await this.saveChain;
  }
}
