/** The sign-in methods the dashboard offers, read from config.json on every
 * request. `serve` used to read them once at start, so a change saved in
 * Settings or with `set` did nothing until a restart and nothing said so.
 * The `serve` flags (`--disable-auth`, `--enable-auth`) still win. */
import { readConfig } from "../config.ts";
import type { AuthMethods } from "./auth.ts";

/** What the `serve` flags force, per method. Unset means config decides. */
export type AuthOverrides = { password?: boolean; github?: boolean };

export type GithubOAuthConfig = {
  clientId: string;
  clientSecret: string;
  allowedUser: string;
};

export type LiveAuthDeps = {
  auth?: AuthMethods;
  githubOAuth?: GithubOAuthConfig;
  /** Set by `serve`: sign-in is then read live. Tests that pass a fixed
   * `auth` leave it out. */
  authOverrides?: AuthOverrides;
};

export function liveAuth(deps: LiveAuthDeps): {
  auth: AuthMethods;
  githubOAuth?: GithubOAuthConfig;
} {
  if (!deps.authOverrides) {
    return {
      auth: deps.auth ?? { password: true, github: false },
      githubOAuth: deps.githubOAuth,
    };
  }
  const config = readConfig();
  const overrides = deps.authOverrides;
  const githubOAuth =
    config.githubOAuthClientId &&
    config.githubOAuthClientSecret &&
    config.githubOAuthAllowedUser
      ? {
          clientId: config.githubOAuthClientId,
          clientSecret: config.githubOAuthClientSecret,
          allowedUser: config.githubOAuthAllowedUser,
        }
      : undefined;
  const password = overrides.password ?? !config.passwordAuthDisabled;
  const github =
    (overrides.github ?? Boolean(config.githubAuthEnabled)) &&
    githubOAuth !== undefined;
  // Saving refuses a state with no way in, but a hand-edited config.json can
  // still hold one. The password stays on then, so nobody is locked out.
  if (!password && !github) {
    return { auth: { password: true, github: false }, githubOAuth };
  }
  return { auth: { password, github }, githubOAuth };
}
