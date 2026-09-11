import { chatBody, parseChatResponse } from "./provider.ts";
import type { AiProvider, AiRequest, AiResponse, Json } from "../types.ts";

export class OpenRouterProvider implements AiProvider {
  private readonly endpoint = "https://openrouter.ai/api/v1/chat/completions";

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    if (!apiKey) throw new Error("OpenRouter requires OPENROUTER_API_KEY");
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(chatBody(this.model, request)),
    });
    if (!response.ok) {
      throw new Error(
        `OpenRouter ${response.status}: ${await response.text()}`,
      );
    }
    return parseChatResponse(
      await response.json() as Json,
      "openrouter",
      this.model,
    );
  }
}
