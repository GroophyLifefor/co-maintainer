import type { AiProvider, AiRequest, AiResponse } from "../types.ts";
import { getEnv, readTextFileSync } from "../util/runtime.ts";

export const FAKE_REVIEW_MARKDOWN = `## Findings

### [P2 · non-blocking] \`src/app.ts\`: \`helper()\`
Location: \`src/app.ts:4\`

The helper ignores its argument, so the new behavior is never applied.

The helper accepts an argument but returns the same result without reading it.

If you'd like me to explain it in more detail, please ask.
`;

function fakeReviewText(): string {
  const path = getEnv("CM_FAKE_REVIEW_FILE");
  if (path) {
    try {
      return readTextFileSync(path);
    } catch {
      // fall through
    }
  }
  return FAKE_REVIEW_MARKDOWN;
}

export class FakeAiProvider implements AiProvider {
  private readonly text: string;

  constructor(text = fakeReviewText()) {
    this.text = text;
  }

  /** `CM_FAKE_AI_DIR/<job>.txt`, when it exists, answers that one job, so a
   * smoke test can give the comment classifier and the review different
   * answers. It is read on every call, so a test can change it between
   * pushes. */
  private jobText(job: string): string | undefined {
    const dir = getEnv("CM_FAKE_AI_DIR");
    if (!dir || !/^[a-z_]+$/.test(job)) return undefined;
    try {
      return readTextFileSync(`${dir}/${job}.txt`);
    } catch {
      return undefined;
    }
  }

  /** With `CM_FAKE_AI_DIR`, each request is appended to `requests.jsonl` so a
   * smoke test can read what was asked, and `delay_ms` slows every answer so
   * it can catch a review while it runs. */
  private async record(request: AiRequest): Promise<void> {
    const dir = getEnv("CM_FAKE_AI_DIR");
    if (!dir) return;
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      `${dir}/requests.jsonl`,
      `${JSON.stringify({ job: request.job, system: request.system ?? "", prompt: request.prompt })}\n`,
    );
    let delay = 0;
    try {
      delay = Number(readTextFileSync(`${dir}/delay_ms`).trim()) || 0;
    } catch {
      // no delay
    }
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    await this.record(request);
    return {
      text: this.jobText(request.job) ?? this.text,
      tokensIn: 10,
      tokensOut: 20,
      cost: 0,
      model: "fake",
      provider: "openrouter",
    };
  }
}
