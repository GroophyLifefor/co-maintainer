import { paginate } from "./client.ts";
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

  async write<T>(endpoint: string, body: unknown): Promise<T> {
    const command = new Deno.Command("gh", {
      args: ["api", "-X", "POST", endpoint, "--input", "-"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const child = command.spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(JSON.stringify(body)));
    await writer.close();
    const result = await child.output();
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

  async createCheckRun<T>(endpoint: string, body: unknown): Promise<T> {
    return await this.write<T>(endpoint, body);
  }

  async updateCheckRun<T>(endpoint: string, body: unknown): Promise<T> {
    const command = new Deno.Command("gh", {
      args: ["api", "-X", "PATCH", endpoint, "--input", "-"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const child = command.spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(JSON.stringify(body)));
    await writer.close();
    const result = await child.output();
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

  pages<T>(
    endpoint: string,
    limit?: number,
    progress?: (page: number, fetched: number) => void,
  ): Promise<T[]> {
    return paginate((e) => this.request<T[]>(e), endpoint, limit, progress);
  }
}
