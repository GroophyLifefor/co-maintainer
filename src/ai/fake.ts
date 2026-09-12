import type { AiProvider, AiRequest, AiResponse } from "../types.ts";

export const FAKE_REVIEW_MARKDOWN = `## Findings

### [P2 · non-blocking] \`src/app.ts\` — \`helper()\`
Location: \`src/app.ts:4\`

The helper ignores its argument, so the new behavior is never applied.

The helper accepts an argument but returns the same result without reading it.

If you want the detailed reasoning, reply to this finding.
`;

export class FakeAiProvider implements AiProvider {
  constructor(private readonly text = FAKE_REVIEW_MARKDOWN) {}

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
