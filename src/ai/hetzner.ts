import { chatBody, parseChatResponse } from "./provider.ts";
import type { AiProvider, AiRequest, AiResponse, Json } from "../types.ts";

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export class HetznerProvider implements AiProvider {
  private readonly endpoint: string;
  private nextRequest = 0;
  private spacing = 8_000;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    endpoint = "https://inference.hetzner.com/api/v1/chat/completions",
    private readonly sleeper: typeof sleep = sleep,
  ) {
    if (!apiKey) throw new Error("Hetzner requires HETZNER_API_KEY");
    if (!model) throw new Error("Hetzner requires HETZNER_MODEL");
    this.endpoint = endpoint;
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    let attempt = 0;
    for (;;) {
      attempt++;
      await this.waitForQuota();
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(chatBody(this.model, request)),
      });
      this.nextRequest = Date.now() + this.spacing;
      if (response.ok) {
        this.spacing = Math.max(8_000, this.spacing * 0.9);
        return parseChatResponse(
          await response.json() as Json,
          "hetzner",
          this.model,
        );
      }
      if ([401, 403, 404].includes(response.status)) {
        throw new Error(
          `Hetzner fatal ${response.status}: ${await response.text()}`,
        );
      }
      if (response.status === 429) {
        this.spacing = Math.min(180_000, this.spacing * 1.5);
        const wait = this.jitter(this.spacing);
        console.log(
          `[ai] hetzner 429 on attempt ${attempt}; retrying in ${
            Math.round(wait / 1000)
          }s`,
        );
        await this.sleeper(wait);
        continue;
      }
      if (response.status >= 500 || response.status === 408) {
        const wait = this.jitter(Math.min(180_000, this.spacing * 1.5));
        console.log(
          `[ai] hetzner ${response.status} on attempt ${attempt}; retrying in ${
            Math.round(wait / 1000)
          }s`,
        );
        await this.sleeper(wait);
        continue;
      }
      throw new Error(`Hetzner ${response.status}: ${await response.text()}`);
    }
  }

  private async waitForQuota(): Promise<void> {
    const wait = this.nextRequest - Date.now();
    if (wait > 0) {
      const jittered = this.jitter(wait);
      console.log(
        `[ai] hetzner quota spacing; waiting ${Math.round(jittered / 1000)}s`,
      );
      await this.sleeper(jittered);
    }
  }

  private jitter(milliseconds: number): number {
    return Math.max(
      250,
      Math.round(milliseconds * (0.8 + Math.random() * 0.4)),
    );
  }
}
