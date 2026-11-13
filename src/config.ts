import { writeTextFileAtomic } from "./util/atomic.ts";
import { guardTestLocation } from "./util/test_location_guard.ts";
import {
  currentPlatform,
  getEnv,
  isNotFound,
  readTextFileSync,
  setEnv,
  type Platform,
} from "./util/runtime.ts";

/** Everything init/remake resolved for one repo, except secrets — an API
 * token is never written to config.json, only ever taken from --token or
 * an env file. Remembering this lets `remake owner/repo` run with no
 * flags and no interactive prompts, reusing what `init` was told. */
export type RepoConfig = {
  auth?: "gh" | "pat";
  ai?:
    | "none"
    | "openrouter"
    | "openai"
    | "anthropic"
    | "opencode-zen"
    | "opencode-go";
  lowModel?: string;
  highModel?: string;
  maxCommits?: number;
  maxPrMonths?: number;
  maxPullRequestChangeLines?: number;
  maxComments?: number;
  /** Overrides the server default for this repository. 1..16. */
  ghConcurrent?: number;
  /** Overrides the server default for this repository. 1..16. */
  aiConcurrent?: number;
  includeCodebase?: boolean;
  includePullRequests?: boolean;
  includePullRequestChanges?: boolean;
  includeCommitHistory?: boolean;
  includeHowRepoWorks?: boolean;
  onlyRequestChangedPr?: boolean;
  prState?: ("open" | "closed" | "merged")[];
  /** The regex that finds the agent instruction files. Blank turns
   * `INSTRUCTIONS.md` off, unset means the default. */
  agentInstructions?: string;
  /** Cap on `INSTRUCTIONS.md` in characters. Unset means the default, `0` or
   * a negative number means no limit. */
  agentInstructionsMaxChars?: number;
  /** Five field cron in UTC, checked by `serve` to queue a remake. */
  remakeCron?: string;
  /** A rejected custom schedule kept only so the settings form can show what
   * was typed. Never read by the scheduler. */
  remakeCronDraft?: string;
  /** How a review decides a blocking finding for this repository. Unset
   * follows the server default. */
  reviewBlocking?: "model" | "severity";
  /** A repository's own review instructions, appended to the built-in
   * reviewer prompt as a `CUSTOM REVIEW INSTRUCTIONS` section. Unset or blank
   * means none. */
  reviewSystemPrompt?: string;
  /** Cap on `reviewSystemPrompt` in characters for this repository. Unset
   * means the default; `0` or a negative number means no limit. */
  reviewSystemPromptMaxChars?: number;
  /** Which diagram language this repository's reviews use. Unset means
   * `mermaid`. `set --repo` writes it, so App reviews can use it too. */
  diagramRuntime?: "mermaid" | "plantuml" | "plantuml-server";
  /** The PlantUML server `plantuml-server` links to. Unset means the public
   * one. */
  plantumlServer?: string;
  /** `svg` or `png`. Unset means `svg`. */
  plantumlOutputFormat?: "svg" | "png";
  /** Cap on one `read-full-diff` answer in characters for this repository.
   * Unset means the default; `0` or a negative number means no limit. */
  reviewReadDiffMaxChars?: number;
};

export type UserConfig = {
  auth?: "gh" | "pat";
  ai?:
    | "none"
    | "openrouter"
    | "openai"
    | "anthropic"
    | "opencode-zen"
    | "opencode-go";
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
  /** Path to the App private key file, kept as a path so the key is never
   * copied into config.json. An inline `githubAppPrivateKey` wins over it. */
  githubAppPrivateKeyPath?: string;
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
  /** scrypt hash of the dashboard password, never the password itself. */
  dashboardPasswordHash?: string;
  /** When `set` last changed a sign-in credential. Dashboard sessions issued
   * before it are refused. */
  credentialsChangedAt?: string;
  defaults?: {
    maxCommits?: number;
    maxPrMonths?: number;
    maxPullRequestChangeLines?: number;
    /** Server default for GitHub calls. 1..16. */
    ghConcurrent?: number;
    /** Server default for AI calls. 1..16. */
    aiConcurrent?: number;
  };
  /** Cap on jobs running at once across all types. Unset means no limit. */
  maxConcurrentJobs?: number;
  /** What a review uses to decide a blocking finding. `model` lets
   * the model's own severity decide, `severity` uses a fixed threshold. */
  reviewBlocking?: "model" | "severity";
  /** The pinned codegraph version to install and detect, replacing the one
   * this build ships. Lets a security fix ship without a new release.
   * `CM_CODEGRAPH_VERSION` overrides it. */
  codegraphVersion?: string;
  /** Remote review CLI target (`co-maintainer set`). */
  remoteHost?: string;
  /** Bearer token for `/api/remote/*`; only written by `set`. */
  remoteToken?: string;
  /** Hosts for which the unpublished-code notice was shown. */
  remoteNoticeShownFor?: string[];
  /** Remote client watchdog timeout; dashboard may override. */
  remoteSyncTimeoutSeconds?: number;
  maxConcurrentRemoteReviewsPerToken?: number;
  remoteToolOutputMaxChars?: number;
  /** Whether remote clients may bring their own AI key. `off`
   * rejects one, `allow` accepts one and falls back to the server key when
   * absent, `require` refuses a review that does not carry one. The
   * `CM_REMOTE_BYOK_POLICY` env var overrides this, which is how a hosted
   * deployment forces the setting. */
  remoteByokPolicy?: ByokPolicy;
  /** The review policy new repositories start with: a template
   * name or a policy object. Unset means the old per repository switches. */
  reviewPolicy?: string | Record<string, unknown>;
  /** The client's own AI key for remote review, sent only when
   * `--remote-byok` (or `remoteByokDefault`) turns it on for a run. Only
   * ever written by `set`. */
  remoteByok?: string;
  /** Whether `co-maintainer review --remote` sends `remoteByok` by default.
   * `--no-remote-byok` turns it off for one run without unsetting this. */
  remoteByokDefault?: boolean;
  repos?: Record<string, RepoConfig>;
};

export type ByokPolicy = "off" | "allow" | "require";

/** The provider's own key variable. It is read only when that provider runs,
 * so a key meant for one provider is never sent to another. */
export function providerKeyEnv(
  ai: string,
  env: (name: string) => string | undefined = getEnv,
): string | undefined {
  if (ai === "openrouter") return env("OPENROUTER_API_KEY");
  if (ai === "opencode-zen" || ai === "opencode-go") {
    return env("OPENCODE_API_KEY");
  }
  return undefined;
}

/** The AI key `serve` uses for its jobs and its setup checks, in the order the
 * CLI resolves it: `CO_MAINTAINER_TOKEN`, then the provider's own variable,
 * then the saved key. Without this a server started with the key in its
 * environment reported AI as not configured and failed every job. */
export function resolvedAiToken(
  config: Pick<UserConfig, "ai" | "token">,
  ai: string | undefined = config.ai,
): string | undefined {
  return (
    getEnv("CO_MAINTAINER_TOKEN") ??
    (ai ? providerKeyEnv(ai) : undefined) ??
    savedTokenFor(config, ai ?? "openrouter")
  );
}

/** The provider the saved key belongs to. A config from before providers
 * were saved holds an OpenRouter key, and so does one where AI was switched
 * off, which the dashboard writes for such a config. */
export function savedKeyProvider(config: Pick<UserConfig, "ai">): string {
  return config.ai && config.ai !== "none" ? config.ai : "openrouter";
}

/** The saved key belongs to the saved provider, so a run on any other
 * provider never receives it. */
export function savedTokenFor(
  config: Pick<UserConfig, "ai" | "token">,
  ai: string,
): string | undefined {
  return savedKeyProvider(config) === ai ? config.token : undefined;
}

/** True when a provider is chosen and a key reaches it from anywhere. */
export function aiConfigured(
  config: Pick<UserConfig, "ai" | "token">,
): boolean {
  return Boolean(config.ai && config.ai !== "none" && resolvedAiToken(config));
}

/** Who pays for a remote review's AI calls. `CM_REMOTE_BYOK_POLICY`
 * overrides the saved config, so a hosted server cannot be talked out of its
 * policy by a config edit. An unset or unreadable value falls back to the
 * config, then to `off`. */
export function remoteByokPolicy(
  config: Pick<UserConfig, "remoteByokPolicy"> = readConfig(),
): ByokPolicy {
  // An env value that is not one of the three known policies is treated as
  // unreadable and falls back to the config, so a typo cannot silently turn a
  // configured `require` into `off`. An explicit `off` still overrides.
  const env = getEnv("CM_REMOTE_BYOK_POLICY");
  const raw =
    env === "off" || env === "allow" || env === "require"
      ? env
      : config.remoteByokPolicy;
  return raw === "allow" || raw === "require" ? raw : "off";
}

function homeDir(env: (name: string) => string | undefined): string {
  const home = env("HOME") ?? env("USERPROFILE");
  if (!home) throw new Error("Could not determine the home directory");
  return home;
}

/** The real environment under another name, so the test location guard can
 * resolve every platform's directory without checking itself again. */
const readEnv = (name: string) => getEnv(name);

/** Platform/env injection keeps the OS branches testable: the
 * migration's `"windows"` vs `"win32"` trap is invisible otherwise. */
export function getConfigDir(
  os: Platform = currentPlatform(),
  env: (name: string) => string | undefined = getEnv,
): string {
  if (env === getEnv) {
    guardTestLocation("config", (other) => getConfigDir(other, readEnv));
  }
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
  if (env === getEnv) {
    guardTestLocation("cache", (other) => getCacheDir(other, readEnv));
  }
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

/** The directory holding one repository's PR worktrees. `clear` removes it
 * whole, so the layout lives in one place instead of at each call site. */
export function repoWorktreesDir(repo: string): string {
  return `${getCacheDir()}/co-maintainer/wt/${repoSlug(repo)}`;
}

/** Every repository's worktrees, for `clear all` and `uninstall`. */
export function worktreesDir(): string {
  return `${getCacheDir()}/co-maintainer/wt`;
}

export function worktreeDir(repo: string, pr: number): string {
  return `${repoWorktreesDir(repo)}/${pr}`;
}

export function cacheDbPath(): string {
  return `${getCacheDir()}/co-maintainer/cache.db`;
}

/** Transient pid files that keep one local review per repository root.
 * `uninstall` still takes them: they are co-maintainer data too. */
export function locksDir(): string {
  return `${getCacheDir()}/co-maintainer/locks`;
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

/** No retry on a parse error: every write replaces the file whole, so a file
 * that does not parse is broken, not half written, and reading it again would
 * give the same answer. */
export function readConfig(): UserConfig {
  try {
    return JSON.parse(readTextFileSync(configPath())) as UserConfig;
  } catch (error) {
    if (isNotFound(error)) return {};
    throw new Error(`Could not read config ${configPath()}: ${String(error)}`);
  }
}

/** The App private key to sign with. An inline `githubAppPrivateKey` wins,
 * then the file named by `githubAppPrivateKeyPath`. Reading the file here
 * instead of copying it into config.json keeps a key on disk in one place.
 * `undefined` when neither is set or the named file cannot be read, which is
 * the same as "App not configured" to every caller. */
export function resolveAppPrivateKey(
  config: Pick<UserConfig, "githubAppPrivateKey" | "githubAppPrivateKeyPath">,
): string | undefined {
  if (config.githubAppPrivateKey) return config.githubAppPrivateKey;
  if (!config.githubAppPrivateKeyPath) return undefined;
  try {
    return readTextFileSync(config.githubAppPrivateKeyPath);
  } catch {
    return undefined;
  }
}

/** `true` when a path is configured but the file is missing or unreadable,
 * so `serve` can warn at startup instead of looking silently unconfigured. */
export function appPrivateKeyFileMissing(
  config: Pick<UserConfig, "githubAppPrivateKey" | "githubAppPrivateKeyPath">,
): boolean {
  if (config.githubAppPrivateKey || !config.githubAppPrivateKeyPath) {
    return false;
  }
  try {
    readTextFileSync(config.githubAppPrivateKeyPath);
    return false;
  } catch {
    return true;
  }
}

/** `serve` reads config.json on every job while `set` can write it from
 * another process, so the file is replaced whole and a reader never sees half
 * of it. config.json can hold an API token (see UserConfig.token), so it stays
 * readable only by the current user where the platform supports it. */
async function writeConfig(config: UserConfig): Promise<void> {
  await writeTextFileAtomic(
    configPath(),
    `${JSON.stringify(config, null, 2)}\n`,
    { mode: 0o600 },
  );
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

/** Drops `repos[repo]` from config.json. `clear` uses this so the repository
 * goes back to "never inited": the next run resolves its flags again. Returns
 * whether there was an entry to drop. */
export async function removeRepoConfig(repo: string): Promise<boolean> {
  const config = readConfig();
  if (!config.repos || !(repo in config.repos)) return false;
  const repos = { ...config.repos };
  delete repos[repo];
  await writeConfig({
    ...config,
    repos: Object.keys(repos).length > 0 ? repos : undefined,
  });
  return true;
}

/** Drops every per-repo entry. `clear all` forgets every repository it knows. */
export async function removeAllRepoConfig(): Promise<boolean> {
  const config = readConfig();
  if (!config.repos || Object.keys(config.repos).length === 0) return false;
  await writeConfig({ ...config, repos: undefined });
  return true;
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
