import { githubFetch, GitHubHttpError, paginate } from "./client.ts";
import type { GitHubClient } from "../types.ts";

export class PatClient implements GitHubClient {
  constructor(private readonly token: string) {
    if (!token) throw new Error("PAT mode requires GITHUB_TOKEN or GH_TOKEN");
  }

  async request<T>(endpoint: string): Promise<T> {
    const response = await githubFetch(`https://api.github.com/${endpoint}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new GitHubHttpError(response.status, await response.text());
    }
    return await response.json() as T;
  }

  async write<T>(endpoint: string, body: unknown): Promise<T> {
    const response = await githubFetch(`https://api.github.com/${endpoint}`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new GitHubHttpError(response.status, await response.text());
    }
    return await response.json() as T;
  }

  async createCheckRun<T>(endpoint: string, body: unknown): Promise<T> {
    return await this.write<T>(endpoint, body);
  }

  async updateCheckRun<T>(endpoint: string, body: unknown): Promise<T> {
    const response = await githubFetch(`https://api.github.com/${endpoint}`, {
      method: "PATCH",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new GitHubHttpError(response.status, await response.text());
    }
    return await response.json() as T;
  }

  pages<T>(
    endpoint: string,
    limit?: number,
    progress?: (page: number, fetched: number) => void,
  ): Promise<T[]> {
    return paginate((e) => this.request<T[]>(e), endpoint, limit, progress);
  }
}
