import {
  chmod,
  currentPlatform,
  getEnv,
  isNotFound,
  mkdir,
  readTextFileSync,
  setEnv,
  type Platform,
  writeTextFile,
} from "./util/runtime.ts";

/** Everything init/remake resolved for one repo, except secrets — an API
 * token is never written to config.json, only ever taken from --token or
 * an env file. Remembering this lets `remake owner/repo` run with no
 * flags and no interactive prompts, reusing what `init` was told. */
export type RepoConfig = {
  auth?: "gh" | "pat";
  ai?: "none" | "openrouter" | "hetzner";
  lowModel?: string;
  highModel?: string;
  maxCommits?: number;
  maxPrMonths?: number;
  maxPullRequestChangeLines?: number;
  maxComments?: number;
  includeCodebase?: boolean;
  includePullRequests?: boolean;
  includePullRequestChanges?: boolean;
  includeCommitHistory?: boolean;
  includeHowRepoWorks?: boolean;
};

export type UserConfig = {
  auth?: "gh" | "pat";
  ai?: "none" | "openrouter" | "hetzner";
  lowModel?: string;
  highModel?: string;
  /** Written only by `co-maintainer set --token=...`. Every other write
   * path (writeRepoConfig, init/remake) must never put a secret here. */
  token?: string;
  /** GitHub Personal Access Token, used when `--auth=pat`. Only ever
   * written by `set --github-pat=...`. */
  githubPat?: string;
  /** GitHub App credentials for `co-maintainer serve` — also only ever
   * written by `set`. `githubWebhookSecret` is optional. */
  githubAppId?: string;
  githubAppPrivateKey?: string;
  githubWebhookSecret?: string;
  webhookUrl?: string;
  /** "Sign in with GitHub" for the dashboard, reusing the App's own OAuth
   * client — only `githubOAuthAllowedUser` may complete it. All three only
   * ever written by `set`. */
  githubOAuthClientId?: string;
  githubOAuthClientSecret?: string;
  githubOAuthAllowedUser?: string;
  /** Which sign-in methods `serve` accepts by default; a `--disable-auth`/
   * `--enable-auth` flag on the `serve` command overrides these per run. */
  passwordAuthDisabled?: boolean;
  githubAuthEnabled?: boolean;
  defaults?: {
    maxCommits?: number;
    maxPrMonths?: number;
    maxPullRequestChangeLines?: number;
  };
  /** Cap on jobs running at once across all types. Unset means no limit. */
  maxConcurrentJobs?: number;
  /** Remote review CLI target (`co-maintainer set`). */
  remoteHost?: string;
  /** Bearer token for `/api/remote/*`; only written by `set`. */
  remoteToken?: string;
  /** Hosts for which the unpublished-code notice was shown (plan §14.1 G13). */
  remoteNoticeShownFor?: string[];
  /** Remote client watchdog timeout; dashboard may override (plan §19.6). */
  remoteSyncTimeoutSeconds?: number;
  maxConcurrentRemoteReviewsPerToken?: number;
  remoteToolOutputMaxChars?: number;
  repos?: Record<string, RepoConfig>;
};

function homeDir(env: (name: string) => string | undefined): string {
  const home = env("HOME") ?? env("USERPROFILE");
  if (!home) throw new Error("Could not determine the home directory");
  return home;
}

/** Platform/env injection keeps the OS branches testable (plan §0b): the
 * migration's `"windows"` vs `"win32"` trap is invisible otherwise. */
export function getConfigDir(
  os: Platform = currentPlatform(),
  env: (name: string) => string | undefined = getEnv,
): string {
  const home = homeDir(env);
  switch (os) {
    case "windows":
      return env("APPDATA") ?? `${home}\\AppData\\Roaming`;
    case "darwin":
      return `${home}/Library/Application Support`;
    default:
      return env("XDG_CONFIG_HOME") ?? `${home}/.config`;
  }
}

export function getCacheDir(
  os: Platform = currentPlatform(),
  env: (name: string) => string | undefined = getEnv,
): string {
  const home = homeDir(env);
  switch (os) {
    case "windows":
      return env("LOCALAPPDATA") ?? `${home}\\AppData\\Local`;
    case "darwin":
      return `${home}/Library/Caches`;
    default:
      return env("XDG_CACHE_HOME") ?? `${home}/.cache`;
  }
}

/** `CM_CONFIG_PATH` overrides the path — tests point it at a temp file so
 * they never read or write the real config.json. */
export function configPath(): string {
  return (
    getEnv("CM_CONFIG_PATH") ?? `${getConfigDir()}/co-maintainer/config.json`
  );
}

/** Where generated skills (SKILL.md, CODEBASE.md, review guides) live.
 * Never relative to the current directory — a globally installed CLI can be
 * invoked from anywhere, including directories it has no permission to
 * write into (e.g. C:\Windows\System32). */
export function reposDir(): string {
  return getEnv("CM_REPOS_DIR") ?? `${getConfigDir()}/co-maintainer/repos`;
}

/** Third-party binaries co-maintainer installs for itself, never onto the
 * user's global PATH. Each tool lives under its own version directory so an
 * upgrade installs alongside the old one instead of over it, and a rollback is
 * just pointing at the previous directory. */
export function toolsDir(): string {
  return getEnv("CM_TOOLS_DIR") ?? `${getConfigDir()}/co-maintainer/tools`;
}

/** A short, stable directory name for a repository. Full `owner-repo` names
 * blow the Windows 260 character path limit once a deep source tree is checked
 * out under them: typescript-eslint's longest path is 169 characters on its
 * own, which leaves under 91 for everything above it. */
export function repoSlug(repo: string): string {
  let hash = 2166136261;
  for (let index = 0; index < repo.length; index++) {
    hash ^= repo.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Clones and worktrees are large, disposable and rebuildable in seconds, so
 * they belong beside the cache rather than in the config directory, which on
 * Windows is the roaming profile and gets synced across machines. */
export function clonesDir(): string {
  return getEnv("CM_CLONES_DIR") ?? `${getCacheDir()}/co-maintainer/clones`;
}

export function cloneDir(repo: string): string {
  return `${clonesDir()}/${repoSlug(repo)}`;
}

export function worktreeDir(repo: string, pr: number): string {
  return `${getCacheDir()}/co-maintainer/wt/${repoSlug(repo)}/${pr}`;
}

export function cacheDbPath(): string {
  return `${getCacheDir()}/co-maintainer/cache.db`;
}

export function loadEnvFile(path: string): void {
  const contents = readTextFileSync(path);
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (getEnv(match[1]) === undefined) setEnv(match[1], value);
  }
}

export function readConfig(): UserConfig {
  try {
    return JSON.parse(readTextFileSync(configPath())) as UserConfig;
  } catch (error) {
    if (isNotFound(error)) return {};
    throw new Error(`Could not read config ${configPath()}: ${String(error)}`);
  }
}

async function writeConfig(config: UserConfig): Promise<void> {
  await mkdir(`${getConfigDir()}/co-maintainer`, { recursive: true });
  const path = configPath();
  await writeTextFile(path, `${JSON.stringify(config, null, 2)}\n`);
  // config.json can hold an API token (see UserConfig.token) — keep it
  // readable only by the current user where the platform supports it.
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows has no POSIX chmod; NotSupported there is expected.
  }
}

/** Merges `patch` into `repos[repo]` in config.json, dropping undefined
 * fields. Never call this with a token or other secret. */
export async function writeRepoConfig(
  repo: string,
  patch: RepoConfig,
): Promise<void> {
  const config = readConfig();
  const repos = { ...config.repos };
  repos[repo] = Object.fromEntries(
    Object.entries({ ...repos[repo], ...patch }).filter(
      ([, value]) => value !== undefined,
    ),
  );
  await writeConfig({ ...config, repos });
}

/** Merges `patch` into the top-level (global, cross-repo) config —
 * used by `co-maintainer set`. This is the only path allowed to persist
 * a token. */
export async function writeUserConfig(
  patch: Partial<UserConfig>,
): Promise<void> {
  const config = readConfig();
  const merged = Object.fromEntries(
    Object.entries({ ...config, ...patch }).filter(
      ([, value]) => value !== undefined,
    ),
  ) as UserConfig;
  await writeConfig(merged);
}

export function prepareConfig(args: string[]): {
  config: UserConfig;
  envPath?: string;
} {
  const envArg = args.find((arg) => arg.startsWith("--env="));
  const envPath = envArg?.slice("--env=".length);
  if (envPath) loadEnvFile(envPath);
  return { config: readConfig(), envPath };
}
