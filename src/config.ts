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
  defaults?: {
    maxCommits?: number;
    maxPrMonths?: number;
    maxPullRequestChangeLines?: number;
  };
  repos?: Record<string, RepoConfig>;
};

function homeDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) throw new Error("Could not determine the home directory");
  return home;
}

export function getConfigDir(): string {
  const home = homeDir();
  switch (Deno.build.os) {
    case "windows":
      return Deno.env.get("APPDATA") ?? `${home}\\AppData\\Roaming`;
    case "darwin":
      return `${home}/Library/Application Support`;
    default:
      return Deno.env.get("XDG_CONFIG_HOME") ?? `${home}/.config`;
  }
}

export function getCacheDir(): string {
  const home = homeDir();
  switch (Deno.build.os) {
    case "windows":
      return Deno.env.get("LOCALAPPDATA") ?? `${home}\\AppData\\Local`;
    case "darwin":
      return `${home}/Library/Caches`;
    default:
      return Deno.env.get("XDG_CACHE_HOME") ?? `${home}/.cache`;
  }
}

/** `CM_CONFIG_PATH` overrides the path — tests point it at a temp file so
 * they never read or write the real config.json. */
export function configPath(): string {
  return Deno.env.get("CM_CONFIG_PATH") ??
    `${getConfigDir()}/co-maintainer/config.json`;
}

/** Where generated skills (SKILL.md, CODEBASE.md, review guides) live.
 * Never relative to the current directory — a globally installed CLI can be
 * invoked from anywhere, including directories it has no permission to
 * write into (e.g. C:\Windows\System32). */
export function reposDir(): string {
  return Deno.env.get("CM_REPOS_DIR") ??
    `${getConfigDir()}/co-maintainer/repos`;
}

/** Third-party binaries co-maintainer installs for itself, never onto the
 * user's global PATH. Each tool lives under its own version directory so an
 * upgrade installs alongside the old one instead of over it, and a rollback is
 * just pointing at the previous directory. */
export function toolsDir(): string {
  return Deno.env.get("CM_TOOLS_DIR") ??
    `${getConfigDir()}/co-maintainer/tools`;
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
  return Deno.env.get("CM_CLONES_DIR") ??
    `${getCacheDir()}/co-maintainer/clones`;
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
  const contents = Deno.readTextFileSync(path);
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
    if (Deno.env.get(match[1]) === undefined) Deno.env.set(match[1], value);
  }
}

export function readConfig(): UserConfig {
  try {
    return JSON.parse(Deno.readTextFileSync(configPath())) as UserConfig;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return {};
    throw new Error(`Could not read config ${configPath()}: ${String(error)}`);
  }
}

async function writeConfig(config: UserConfig): Promise<void> {
  await Deno.mkdir(`${getConfigDir()}/co-maintainer`, { recursive: true });
  const path = configPath();
  await Deno.writeTextFile(path, `${JSON.stringify(config, null, 2)}\n`);
  // config.json can hold an API token (see UserConfig.token) — keep it
  // readable only by the current user where the platform supports it.
  try {
    await Deno.chmod(path, 0o600);
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
