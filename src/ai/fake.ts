import type { AiProvider, AiRequest, AiResponse } from "../types.ts";

export const FAKE_REVIEW_MARKDOWN = `## Findings

### P2 src/app.ts:4 unused value

src/app.ts:4

The new helper ignores its argument. Use the value or drop the parameter.
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
