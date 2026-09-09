import type { GitHubClient } from "../types.ts";

export class PatClient implements GitHubClient {
  constructor(private readonly token: string) {
    if (!token) throw new Error("PAT mode requires GITHUB_TOKEN or GH_TOKEN");
  }

  async request<T>(endpoint: string): Promise<T> {
    const response = await fetch(`https://api.github.com/${endpoint}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(
        `GitHub API ${response.status}: ${await response.text()}`,
      );
    }
    return await response.json() as T;
  }

  async pages<T>(
    endpoint: string,
    limit?: number,
    progress?: (page: number, fetched: number) => void,
  ): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1;; page++) {
      const separator = endpoint.includes("?") ? "&" : "?";
      const pageItems = await this.request<T[]>(
        `${endpoint}${separator}per_page=100&page=${page}`,
      );
      items.push(...pageItems);
      progress?.(page, items.length);
      if (
        pageItems.length < 100 ||
        (limit !== undefined && items.length >= limit)
      ) break;
    }
    return limit === undefined ? items : items.slice(0, limit);
  }
}
