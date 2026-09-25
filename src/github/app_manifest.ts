/** The GitHub App manifest flow: create the App from the dashboard so its
 * webhook secret, private key, and OAuth credentials are written straight
 * into config.json instead of being copied by hand between two screens.
 *
 * Permissions and events are derived from the calls this codebase actually
 * makes, not guessed:
 *  - `contents: read`   read PR_REVIEW_GUIDE.md, file contents, git trees
 *  - `pull_requests: write`  post reviews and review comments, read a PR
 *  - `issues: write`    post issue comments, read them
 *  - `checks: write`    create and update the review check run
 *  - `metadata: read`   required by every App
 *  - events             handled by `dispatchGithubEvent` in services/webhook.ts
 *
 * `installation` and `installation_repositories` are deliberately absent:
 * GitHub delivers both to every App without a subscription, which is why
 * `webhook.ts` handles them at all. */
import { githubFetch } from "./client.ts";
import { webhookReachabilityProblem } from "../util/webhook_reachability.ts";

export const APP_MANIFEST_PERMISSIONS = {
  contents: "read",
  issues: "write",
  pull_requests: "write",
  checks: "write",
  metadata: "read",
} as const;

export const APP_MANIFEST_EVENTS = [
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
] as const;

/** GitHub App names are globally unique and capped at 34 characters. */
export const APP_NAME_MAX = 34;

export type AppManifest = {
  name: string;
  url: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  callback_urls: string[];
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
};

export function buildAppManifest(input: {
  name: string;
  baseUrl: string;
  webhookUrl: string;
}): AppManifest {
  const base = input.baseUrl.replace(/\/+$/, "");
  return {
    name: input.name.trim(),
    url: base,
    hook_attributes: { url: input.webhookUrl, active: true },
    redirect_url: `${base}/github/app-manifest/callback`,
    callback_urls: [`${base}/auth/github/callback`],
    public: false,
    default_permissions: { ...APP_MANIFEST_PERMISSIONS },
    default_events: [...APP_MANIFEST_EVENTS],
  };
}

/** `co-maintainer-<host>`, shortened to fit the 34 character cap. The name
 * is only a suggestion: GitHub rejects a duplicate and the field stays
 * editable. */
export function defaultAppName(host: string): string {
  const clean = host
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = `co-maintainer-${clean}`;
  return name.length <= APP_NAME_MAX
    ? name
    : name.slice(0, APP_NAME_MAX).replace(/-+$/, "");
}

export function appNameProblem(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name for the GitHub App.";
  if (trimmed.length > APP_NAME_MAX) {
    return `The name must be ${APP_NAME_MAX} characters or fewer.`;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(trimmed)) {
    return "Use letters, digits, and hyphens only, starting with a letter or digit.";
  }
  return undefined;
}

/** Why the App cannot be created yet, or `undefined` when its webhook
 * address looks reachable from GitHub. */
export function manifestBlockedReason(webhookUrl: string): string | undefined {
  if (!webhookUrl.trim()) {
    return "Set a webhook address before creating the App.";
  }
  const reach = webhookReachabilityProblem(webhookUrl);
  if (reach) return `${reach} Set a public webhook address first.`;
  return undefined;
}

export type ManifestConversion = {
  appId: string;
  slug: string;
  pem: string;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
};

/** `POST /app-manifests/{code}/conversions` — the `code` is single use and
 * expires roughly an hour after GitHub redirects the browser back. */
export async function convertManifest(
  code: string,
): Promise<ManifestConversion> {
  const response = await githubFetch(
    `https://api.github.com/app-manifests/${encodeURIComponent(
      code,
    )}/conversions`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub App conversion failed (${response.status}).`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const id = body.id;
  const appId =
    typeof id === "number" ? String(id) : typeof id === "string" ? id : "";
  if (!appId || !text(body.pem)) {
    throw new Error("GitHub returned an incomplete App conversion.");
  }
  return {
    appId,
    slug: text(body.slug),
    pem: text(body.pem),
    webhookSecret: text(body.webhook_secret),
    clientId: text(body.client_id),
    clientSecret: text(body.client_secret),
  };
}

/** One dashboard admin, one in-flight App creation at a time, so a
 * server-side map is enough. A cookie would work too, but keeping the token
 * out of the browser is one less thing to forge. Expired entries are swept
 * on the next start, and a state is single use. */
const MANIFEST_STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map<string, number>();

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function beginManifestState(now = Date.now()): string {
  for (const [state, expires] of pendingStates) {
    if (expires <= now) pendingStates.delete(state);
  }
  const state = randomState();
  pendingStates.set(state, now + MANIFEST_STATE_TTL_MS);
  return state;
}

/** `false` for an unknown state, a replayed one, or an expired one. */
export function consumeManifestState(state: string, now = Date.now()): boolean {
  const expires = pendingStates.get(state);
  if (expires === undefined) return false;
  pendingStates.delete(state);
  return expires > now;
}
