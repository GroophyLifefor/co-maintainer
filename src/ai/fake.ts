import type { AiProvider, AiRequest, AiResponse } from "../types.ts";
import { getEnv, readTextFileSync } from "../util/runtime.ts";

export const FAKE_REVIEW_MARKDOWN = `## Findings

### [P2 · non-blocking] \`src/app.ts\` — \`helper()\`
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

  complete(_request: AiRequest): Promise<AiResponse> {
    return Promise.resolve({
      text: this.text,
      tokensIn: 10,
      tokensOut: 20,
      cost: 0,
      model: "fake",
      provider: "openrouter",
    });
  }
}
