/** Probe GitHub credentials before they are saved. A token that cannot
 * authenticate, or an App missing the permissions in PLAN.md Section 6,
 * is rejected instead of stored and failing later on a review. */
import { githubFetch, GitHubHttpError } from "../github/client.ts";
import { AppJwtClient, type Installation } from "../github/app.ts";
import { GhClient } from "../github/gh.ts";

const APP_NEED: Record<string, "read" | "write"> = {
  metadata: "read",
  contents: "read",
  issues: "write",
  pull_requests: "write",
  checks: "write",
};

export type AccessOk = { ok: true; login?: string; installations?: number };
export type AccessFail = { ok: false; message: string };
export type AccessResult = AccessOk | AccessFail;

export function missingAppPermissions(
  permissions: Record<string, string> | undefined,
): string[] {
  const got = permissions ?? {};
  const missing: string[] = [];
  for (const [name, need] of Object.entries(APP_NEED)) {
    const value = got[name];
    if (need === "write") {
      if (value !== "write") missing.push(`${name} write`);
    } else if (value !== "read" && value !== "write") {
      missing.push(`${name} read`);
    }
  }
  return missing;
}

export async function testGithubAccess(opts: {
  auth: "gh" | "pat";
  githubPat?: string;
}): Promise<AccessResult> {
  if (opts.auth === "pat") return await testPat(opts.githubPat ?? "");
  return await testGh();
}

export async function testAppAccess(opts: {
  appId: string;
  privateKeyPem: string;
}): Promise<AccessResult> {
  if (!opts.appId.trim() || !opts.privateKeyPem.trim()) {
    return { ok: false, message: "App ID and private key are required." };
  }
  try {
    const app = new AppJwtClient(opts.appId, opts.privateKeyPem);
    const installations = await app.listInstallations();
    for (const installation of installations) {
      const missing = missingAppPermissions(installation.permissions);
      if (missing.length === 0) continue;
      const account = installation.account?.login ??
        `installation ${installation.id}`;
      return {
        ok: false,
        message: `The App on ${account} is missing ${missing.join(" and ")}.`,
      };
    }
    return { ok: true, installations: installations.length };
  } catch (error) {
    return { ok: false, message: humanGithubError(error) };
  }
}

async function testPat(token: string): Promise<AccessResult> {
  if (!token.trim()) {
    return {
      ok: false,
      message: "A personal access token is required for PAT access.",
    };
  }
  const user = await githubGet("user", token);
  if (user.status === 401) {
    return { ok: false, message: "This personal access token was rejected." };
  }
  if (!user.ok) {
    return { ok: false, message: "GitHub rejected this token." };
  }
  const scopes = user.scopes;
  if (scopes.length > 0) {
    const canRead = scopes.includes("repo") || scopes.includes("public_repo");
    if (!canRead) {
      return {
        ok: false,
        message: "This token cannot read repositories. Grant the repo scope.",
      };
    }
    return { ok: true, login: user.login };
  }
  const repos = await githubGet("user/repos?per_page=1", token);
  if (repos.status === 403 || repos.status === 401) {
    return {
      ok: false,
      message: "This token cannot list repositories. Grant repository access.",
    };
  }
  if (!repos.ok) {
    return { ok: false, message: "GitHub rejected this token." };
  }
  return { ok: true, login: user.login };
}

async function testGh(): Promise<AccessResult> {
  try {
    const user = await new GhClient().request<{ login: string }>("user");
    if (!user.login) {
      return { ok: false, message: "gh CLI did not return a GitHub login." };
    }
    return { ok: true, login: user.login };
  } catch (error) {
    return {
      ok: false,
      message: "gh CLI could not reach GitHub. Sign in with gh auth login.",
    };
  }
}

async function githubGet(
  endpoint: string,
  token: string,
): Promise<{ ok: boolean; status: number; login?: string; scopes: string[] }> {
  const response = await githubFetch(`https://api.github.com/${endpoint}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const scopes = (response.headers.get("x-oauth-scopes") ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (!response.ok) {
    return { ok: false, status: response.status, scopes };
  }
  let login: string | undefined;
  try {
    const body = await response.json() as { login?: string };
    login = body.login;
  } catch {
    login = undefined;
  }
  return { ok: true, status: response.status, login, scopes };
}

function humanGithubError(error: unknown): string {
  if (error instanceof GitHubHttpError) {
    if (error.status === 401) {
      return "GitHub rejected this App ID or private key.";
    }
    return "GitHub rejected this App.";
  }
  const text = error instanceof Error ? error.message : String(error);
  if (text.toLowerCase().includes("private key")) {
    return "This private key could not be read.";
  }
  return "GitHub rejected this App.";
}
