import type { GitHubClient } from "../types.ts";

export class GhClient implements GitHubClient {
  async request<T>(endpoint: string): Promise<T> {
    const command = new Deno.Command("gh", {
      args: ["api", endpoint],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();
    if (!result.success) {
      const error = new TextDecoder().decode(result.stderr).trim();
      throw new Error(`gh api failed: ${error || endpoint}`);
    }
    try {
      return JSON.parse(new TextDecoder().decode(result.stdout)) as T;
    } catch {
      throw new Error(`gh returned invalid JSON for ${endpoint}`);
    }
  }

  async pages<T>(endpoint: string, limit?: number): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1;; page++) {
      const separator = endpoint.includes("?") ? "&" : "?";
      const pageItems = await this.request<T[]>(
        `${endpoint}${separator}per_page=100&page=${page}`,
      );
      items.push(...pageItems);
      if (
        pageItems.length < 100 ||
        (limit !== undefined && items.length >= limit)
      ) break;
    }
    return limit === undefined ? items : items.slice(0, limit);
  }
}
