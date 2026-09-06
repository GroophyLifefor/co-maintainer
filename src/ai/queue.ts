import { cacheRoot } from "../state/state.ts";
import type { AiProvider, AiRequest, AiResponse } from "../types.ts";

type JobRecord = {
  status: "done" | "quarantine";
  response?: AiResponse;
  error?: string;
  updatedAt: string;
};

type JobCache = Record<string, JobRecord>;
type UsageSink = (job: string, response: AiResponse) => Promise<void>;

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export class AiQueue {
  private records: JobCache = {};
  private loaded = false;
  private saveChain = Promise.resolve();

  constructor(
    private readonly provider: AiProvider,
    private readonly repo: string,
    private readonly concurrency: number,
    private readonly profile: string,
  ) {}

  async run(
    requests: AiRequest[],
    usage?: UsageSink,
  ): Promise<(AiResponse | undefined)[]> {
    await this.load();
    const results: (AiResponse | undefined)[] = new Array(requests.length);
    const pending: { index: number; id: string; request: AiRequest }[] = [];

    for (let index = 0; index < requests.length; index++) {
      const request = requests[index];
      const id = await digest(JSON.stringify({
        profile: this.profile,
        job: request.job,
        system: request.system,
        prompt: request.prompt,
        maxTokens: request.maxTokens,
      }));
      const cached = this.records[id];
      if (cached?.status === "done" && cached.response) {
        results[index] = cached.response;
        console.log(`[ai] cache hit ${request.job} ${id.slice(0, 8)}`);
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
            `[ai] still running ${item.request.job} ${
              item.id.slice(0, 8)
            } · ${seconds}s`,
          );
        }, 15_000);
        try {
          const response = await this.provider.complete(item.request);
          this.records[item.id] = {
            status: "done",
            response,
            updatedAt: new Date().toISOString(),
          };
          results[item.index] = response;
          await this.persist();
          if (usage) await usage(item.request.job, response);
          console.log(
            `[ai] done ${item.request.job} ${item.id.slice(0, 8)} · ${
              Math.round((Date.now() - startedAt) / 1000)
            }s`,
          );
        } catch (error) {
          this.records[item.id] = {
            status: "quarantine",
            error: String(error),
            updatedAt: new Date().toISOString(),
          };
          await this.persist();
          console.log(
            `[ai] quarantined ${item.request.job} ${item.id.slice(0, 8)}: ${
              String(error)
            }`,
          );
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

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.records = JSON.parse(
        await Deno.readTextFile(`${cacheRoot(this.repo)}/ai-jobs.json`),
      ) as JobCache;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.records, null, 2) + "\n";
    this.saveChain = this.saveChain.then(async () => {
      await Deno.mkdir(cacheRoot(this.repo), { recursive: true });
      await Deno.writeTextFile(
        `${cacheRoot(this.repo)}/ai-jobs.json`,
        snapshot,
      );
    });
    await this.saveChain;
  }
}
