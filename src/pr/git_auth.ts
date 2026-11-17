/** How git authenticates to GitHub for a repository the App reviews.
 *
 * Without this, a clone uses the machine's own git login, so on a server that
 * has the App but no git login a private repository cannot be cloned and the
 * review runs on the diff alone. The token goes to git through
 * `GIT_CONFIG_*` environment variables for that one command: it is never
 * written to `.git/config`, never on the command line where `ps` shows it, and
 * git does not print the header in its errors. */
import { cloneDir } from "../config.ts";

type TokenSource = () => Promise<string>;

/** By clone directory, so a fetch inside a clone finds the token without
 * knowing the repository's name. */
const sources = new Map<string, TokenSource>();

/** Registered by an App job before it reviews `repo`. A later job of the same
 * repository replaces it: both mint tokens for the same installation. */
export function setGitHubAuth(repo: string, token: TokenSource): void {
  sources.set(cloneDir(repo), token);
}

export function clearGitHubAuthForTest(): void {
  sources.clear();
}

/** The environment that gives git the token for `https://github.com/`, or
 * `undefined` when no App job registered one for this clone. A token that
 * cannot be minted leaves git on the machine's own login. */
export async function gitAuthEnv(
  dir: string,
): Promise<Record<string, string> | undefined> {
  const source = sources.get(dir);
  if (!source) return undefined;
  let token: string;
  try {
    token = await source();
  } catch {
    return undefined;
  }
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}
