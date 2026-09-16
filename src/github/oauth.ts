/** The user-to-server side of a GitHub App's OAuth flow — "Sign in with
 * GitHub" — reusing the App's own client ID/secret. No separate OAuth App
 * is needed. */
import { githubFetch } from "./client.ts";

export function githubAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

async function exchangeGithubCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<string | undefined> {
  const response = await githubFetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        code: opts.code,
        redirect_uri: opts.redirectUri,
      }),
    },
  );
  if (!response.ok) return undefined;
  const body = await response.json() as { access_token?: string };
  return body.access_token;
}

async function githubLoginFor(accessToken: string): Promise<string | undefined> {
  const response = await githubFetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) return undefined;
  const body = await response.json() as { login?: string };
  return body.login;
}

/** Exchanges an authorization `code` for the GitHub login it belongs to,
 * or `undefined` if the exchange or the `/user` lookup fails. */
export async function githubLoginFromCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<string | undefined> {
  const accessToken = await exchangeGithubCode(opts);
  if (!accessToken) return undefined;
  return await githubLoginFor(accessToken);
}
