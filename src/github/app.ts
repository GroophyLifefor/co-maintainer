import { githubFetch, httpError, paginate } from "./client.ts";
import { importAppPrivateKey, signAppJwt } from "./jwt.ts";
import type { GitHubClient, Json } from "../types.ts";

export type Installation = {
  id: number;
  account: { login: string; type: string } | null;
  suspended_at: string | null;
  permissions?: Record<string, string>;
};

const API = "https://api.github.com";

function headers(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function call<T>(
  endpoint: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await githubFetch(`${API}/${endpoint}`, {
    ...init,
    headers: { ...headers(token), ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    throw await httpError(response, init.method ?? "GET", endpoint, "App");
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function get<T>(endpoint: string, token: string): Promise<T> {
  return await call<T>(endpoint, token);
}

type TokenCache = { token: string; expiresAt: number };
const installationTokens = new Map<number, TokenCache>();

/** App-level calls: list installations, mint an installation access token.
 * Not scoped to one installation — `AppClient` below is. */
export class AppJwtClient {
  private readonly appId: string;
  private readonly privateKeyPem: string;

  constructor(appId: string, privateKeyPem: string) {
    this.appId = appId;
    this.privateKeyPem = privateKeyPem;
  }

  private async jwt(): Promise<string> {
    const key = await importAppPrivateKey(this.privateKeyPem);
    return await signAppJwt(this.appId, key);
  }

  async listInstallations(): Promise<Installation[]> {
    const jwt = await this.jwt();
    return await paginate<Installation>(
      (endpoint) => get<Installation[]>(endpoint, jwt),
      "app/installations",
    );
  }

  /** Cached until 60s before the token's own `expires_at`. */
  async installationToken(installationId: number): Promise<string> {
    const cached = installationTokens.get(installationId);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const jwt = await this.jwt();
    const response = await githubFetch(
      `${API}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: headers(jwt),
      },
    );
    if (!response.ok) {
      throw new Error(
        `GitHub API ${response.status}: ${await response.text()}`,
      );
    }
    const body = (await response.json()) as {
      token: string;
      expires_at: string;
    };
    const expiresAt = new Date(body.expires_at).getTime();
    installationTokens.set(installationId, { token: body.token, expiresAt });
    return body.token;
  }
}

/** A `GitHubClient` scoped to one installation. */
export class AppClient implements GitHubClient {
  private readonly app: AppJwtClient;
  private readonly installationId: number;

  constructor(appId: string, privateKeyPem: string, installationId: number) {
    this.app = new AppJwtClient(appId, privateKeyPem);
    this.installationId = installationId;
  }

  async request<T>(endpoint: string): Promise<T> {
    return await get<T>(
      endpoint,
      await this.app.installationToken(this.installationId),
    );
  }

  async pages<T>(
    endpoint: string,
    limit?: number,
    progress?: (page: number, fetched: number) => void,
  ): Promise<T[]> {
    const token = await this.app.installationToken(this.installationId);
    return await paginate<T>(
      (e) => get<T[]>(e, token),
      endpoint,
      limit,
      progress,
    );
  }

  async write<T>(endpoint: string, body: unknown): Promise<T> {
    return await call<T>(
      endpoint,
      await this.app.installationToken(this.installationId),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }

  async createCheckRun<T>(endpoint: string, body: unknown): Promise<T> {
    return await this.write<T>(endpoint, body);
  }

  async updateCheckRun<T>(endpoint: string, body: unknown): Promise<T> {
    return await call<T>(
      endpoint,
      await this.app.installationToken(this.installationId),
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }
}

export type InstallationRepos = {
  installation: Installation;
  repos: { fullName: string; private: boolean }[];
};

/** For `GET /api/installations`: every installation the App has, each with
 * the repos it can see. */
export async function listInstallationsWithRepos(
  appId: string,
  privateKeyPem: string,
): Promise<InstallationRepos[]> {
  const app = new AppJwtClient(appId, privateKeyPem);
  const installations = await app.listInstallations();
  const result: InstallationRepos[] = [];
  for (const installation of installations) {
    const token = await app.installationToken(installation.id);
    const body = await get<Json>("installation/repositories", token);
    const repos = Array.isArray(body.repositories)
      ? (body.repositories as Json[]).map((repo) => ({
          fullName: String(repo.full_name ?? ""),
          private: Boolean(repo.private),
        }))
      : [];
    result.push({ installation, repos });
  }
  return result;
}

export type OpenPull = {
  number: number;
  title: string;
  draft: boolean;
  author: string;
  headRef: string;
  updatedAt: string;
};

/** Open, non-draft pull requests for one repository through the installation
 * that can see it, for the Pull requests tab. `undefined` when no installation
 * covers the repo, so the caller can tell "not installed" from "none open"
 * instead of showing an empty list for a setup mistake. */
export async function listOpenPulls(
  appId: string,
  privateKeyPem: string,
  fullName: string,
): Promise<OpenPull[] | undefined> {
  const installationId = await findInstallationForRepo(
    appId,
    privateKeyPem,
    fullName,
  );
  if (installationId === undefined) return undefined;
  const client = new AppClient(appId, privateKeyPem, installationId);
  const [owner, repo] = fullName.split("/");
  const raw = await client.pages<Json>(
    `repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc`,
    100,
  );
  return raw
    .filter((pull) => pull.draft !== true)
    .map((pull) => ({
      number: Number(pull.number ?? 0),
      title: String(pull.title ?? ""),
      draft: false,
      author: String((pull.user as Json | undefined)?.login ?? ""),
      headRef: String((pull.head as Json | undefined)?.ref ?? ""),
      updatedAt: String(pull.updated_at ?? ""),
    }))
    .filter((pull) => Number.isSafeInteger(pull.number) && pull.number > 0);
}

export async function findInstallationForRepo(
  appId: string,
  privateKeyPem: string,
  fullName: string,
): Promise<number | undefined> {
  const normalized = fullName.toLowerCase();
  const installations = await listInstallationsWithRepos(appId, privateKeyPem);
  const match = installations.find(({ repos }) =>
    repos.some((repo) => repo.fullName.toLowerCase() === normalized),
  );
  return match?.installation.id;
}
