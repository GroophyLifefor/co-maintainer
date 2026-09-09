export type UserConfig = {
  auth?: "gh" | "pat";
  ai?: "none" | "openrouter" | "hetzner";
  lowModel?: string;
  highModel?: string;
  defaults?: {
    maxCommits?: number;
    maxPrMonths?: number;
    maxPullRequestChangeLines?: number;
  };
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

export function configPath(): string {
  return `${getConfigDir()}/co-maintainer/config.json`;
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

export function prepareConfig(args: string[]): {
  config: UserConfig;
  envPath?: string;
} {
  const envArg = args.find((arg) => arg.startsWith("--env="));
  const envPath = envArg?.slice("--env=".length);
  if (envPath) loadEnvFile(envPath);
  return { config: readConfig(), envPath };
}
