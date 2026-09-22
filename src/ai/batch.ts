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
 * poisoned every later `sync` (CORE-30 / F04). */
export type AiValidator = (
  request: AiRequest,
  response: AiResponse,
) => string | null;

/** A unit whose output never parsed, kept so the run can say what it dropped. */
export type SkippedUnit = { index: number; job: string; reason: string };

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
  private readonly skipped: SkippedUnit[] = [];

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

  /** Units whose output did not parse this run (or on re-try), in request order. */
  skippedUnits(): SkippedUnit[] {
    return [...this.skipped];
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
        console.log(
          `[ai] quarantined job skipped: ${request.job} ${id.slice(0, 8)}`,
        );
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

  /** Runs one unit, caching its response only when the validator accepts it.
   * A rejected response is retried once; a second rejection is recorded as
   * skipped and never cached, so the next `sync` retries it rather than
   * replaying the same unusable output (CORE-30 / F04). */
  private async completeUnit(
    item: { index: number; id: string; request: AiRequest },
    results: (AiResponse | undefined)[],
    usage: UsageSink | undefined,
    startedAt: number,
  ): Promise<void> {
    for (const attempt of [1, 2]) {
      try {
        const response = await this.provider.complete(item.request);
        const reason = this.validate?.(item.request, response) ?? null;
        if (reason !== null) {
          if (attempt === 2) {
            this.markSkipped(item, reason);
            return;
          }
          console.log(
            `[ai] retrying ${item.request.job} ${item.id.slice(0, 8)}: ${reason}`,
          );
          continue;
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
          `[ai] ${attempt === 1 ? "done" : "retried"} ${item.request.job} ${item.id.slice(0, 8)} · ${Math.round(
            (Date.now() - startedAt) / 1000,
          )}s`,
        );
        return;
      } catch (error) {
        this.records[item.id] = {
          status: "quarantine",
          error: formatError(error),
          updatedAt: new Date().toISOString(),
        };
        await this.persist();
        console.log(
          `[ai] quarantined ${item.request.job} ${item.id.slice(0, 8)}: ${formatError(error)}`,
        );
        return;
      }
    }
  }

  /** Records a unit as skipped: no cache write, so it stays retried and its
   * absence is never mistaken for a deliberate empty result. */
  private markSkipped(
    item: { index: number; request: AiRequest },
    reason: string,
  ): void {
    this.skipped.push({
      index: item.index,
      job: item.request.job,
      reason,
    });
    console.log(`[ai] skipped ${item.request.job} ${item.index}: ${reason}`);
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
