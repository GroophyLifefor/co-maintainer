/** The one list of GitHub calls this codebase makes and what each needs.
 *
 * The App manifest, the App permission check on save, the 403 and 404 hints
 * and the permission tables in the docs are all read from `ENDPOINTS`.
 * `permissions.test.ts` scans the source for every endpoint it calls and fails
 * when one is missing here, so a new call cannot ship without its permission. */

export type Level = "read" | "write";
export type Permission =
  | "metadata"
  | "contents"
  | "pull_requests"
  | "issues"
  | "checks";
/** `gh` is a signed-in GitHub CLI, `pat` a personal access token, `app` a
 * GitHub App installation token. */
export type Identity = "gh" | "pat" | "app";

export type Endpoint = {
  method: "GET" | "POST" | "PATCH";
  /** `{repo}` is `owner/name`, `{path}` may hold slashes, any other
   * placeholder is one path segment. */
  pattern: string;
  permission?: Permission;
  level?: Level;
  identities: readonly Identity[];
  feature: string;
};

/** Key order is the order the manifest and the doc tables list them in. */
export const PERMISSION_LABEL: Record<Permission, string> = {
  contents: "Contents",
  issues: "Issues",
  pull_requests: "Pull requests",
  checks: "Checks",
  metadata: "Metadata",
};

const ORDER = Object.keys(PERMISSION_LABEL) as Permission[];
const READERS: readonly Identity[] = ["gh", "pat", "app"];
const APP_ONLY: readonly Identity[] = ["app"];

export const ENDPOINTS: readonly Endpoint[] = [
  {
    method: "GET",
    pattern: "repos/{repo}",
    permission: "metadata",
    level: "read",
    identities: READERS,
    feature: "Read the repository and its default branch",
  },
  {
    method: "GET",
    pattern: "repos/{repo}/pulls",
    permission: "pull_requests",
    level: "read",
    identities: READERS,
    feature: "List pull requests",
  },
  {
    method: "GET",
    pattern: "repos/{repo}/pulls/{n}",
    permission: "pull_requests",
    level: "read",
    identities: READERS,
    feature: "Read a pull request",
  },
  {
    method: "GET",
    pattern: "repos/{repo}/pulls/{n}/files",
    permission: "pull_requests",
    level: "read",
    identities: READERS,
    feature: "Read the files a pull request changes",
  },
  {
    method: "GET",
    pattern: "repos/{repo}/pulls/{n}/reviews",
    permission: "pull_requests",
    level: "read",
    identities: READERS,
    feature: "Read earlier reviews",
  },
  {
    method: "GET",
    pattern: "repos/{repo}/pulls/{n}/comments",
    permission: "pull_requests",
    level: "read",
    identities: READERS,
    feature: "Read review comment threads",
  },
  {
    method: "POST",
    pattern: "repos/{repo}/pulls/{n}/reviews",
    permission: "pull_requests",
    level: "write",
    identities: APP_ONLY,
    feature: "Post a review",
  },
  {
    method: "POST",
    pattern: "repos/{repo}/pulls/{n}/comments",
    permission: "pull_requests",
    level: "write",
    identities: APP_ONLY,
    feature: "Reply in a review comment thread",
  },
  {
    method: "GET",
    pattern: "repos/{repo}/issues/{n}/comments",
    permission: "issues",
    level: "read",
    identities: READERS,
    feature: "Read the conversation on a pull request",
  },
  {
    method: "POST",
    pattern: "repos/{repo}/issues/{n}/comments",
    permission: "issues",
    level: "write",
    identities: APP_ONLY,
    feature: "Post a conversation comment",
  },
  {
    method: "GET",
    pattern: "repos/{repo}/contents/{path}",
    permission: "contents",
    level: "read",
    identities: READERS,
    feature: "Read files and PR_REVIEW_GUIDE.md",
  },
  {
    method: "GET",
    pattern: "repos/{repo}/git/trees/{ref}",
    permission: "contents",
    level: "read",
    identities: READERS,
    feature: "Read the file tree",
  },
  {
    method: "GET",
    pattern: "repos/{repo}/commits",
    permission: "contents",
    level: "read",
    identities: READERS,
    feature: "Read commit history",
  },
  {
    method: "GET",
    pattern: "repos/{repo}/compare/{range}",
    permission: "contents",
    level: "read",
    identities: READERS,
    feature: "Compare two commits",
  },
  {
    method: "GET",
    pattern: "repos/{repo}/releases",
    permission: "contents",
    level: "read",
    identities: READERS,
    feature: "Read releases in the probe",
  },
  {
    method: "POST",
    pattern: "repos/{repo}/check-runs",
    permission: "checks",
    level: "write",
    identities: APP_ONLY,
    feature: "Create the review check run",
  },
  {
    method: "PATCH",
    pattern: "repos/{repo}/check-runs/{id}",
    permission: "checks",
    level: "write",
    identities: APP_ONLY,
    feature: "Update the review check run",
  },
  // Calls that need no repository permission. `credentials.ts` and `gh.ts`
  // make the first two, `app.ts` the App ones, `oauth.ts` the dashboard sign-in.
  {
    method: "GET",
    pattern: "user",
    identities: ["gh", "pat"],
    feature: "Check who the credential belongs to",
  },
  {
    method: "GET",
    pattern: "user/repos",
    permission: "metadata",
    level: "read",
    identities: ["pat"],
    feature: "Check the token can list repositories",
  },
  {
    method: "GET",
    pattern: "rate_limit",
    identities: ["gh"],
    feature: "Print the remaining quota with --debug",
  },
  {
    method: "GET",
    pattern: "app/installations",
    identities: APP_ONLY,
    feature: "List where the App is installed",
  },
  {
    method: "POST",
    pattern: "app/installations/{id}/access_tokens",
    identities: APP_ONLY,
    feature: "Mint an installation token",
  },
  {
    method: "GET",
    pattern: "installation/repositories",
    identities: APP_ONLY,
    feature: "List the repositories an installation can see",
  },
  {
    method: "POST",
    pattern: "app-manifests/{code}/conversions",
    identities: [],
    feature: "Finish creating the App from the dashboard",
  },
];

function strongest(
  identity: Identity,
): Partial<Record<Permission, { level: Level; features: string[] }>> {
  const result: Partial<
    Record<Permission, { level: Level; features: string[] }>
  > = {};
  for (const endpoint of ENDPOINTS) {
    if (!endpoint.permission || !endpoint.identities.includes(identity)) {
      continue;
    }
    const entry = (result[endpoint.permission] ??= {
      level: "read",
      features: [],
    });
    if (endpoint.level === "write") entry.level = "write";
    entry.features.push(endpoint.feature);
  }
  return result;
}

/** What the App must be granted, in the shape the manifest and the save-time
 * check want. */
export const APP_PERMISSIONS: Record<string, Level> = Object.fromEntries(
  ORDER.flatMap((name) => {
    const entry = strongest("app")[name];
    return entry ? [[name, entry.level]] : [];
  }),
);

function patternRegex(pattern: string): RegExp {
  const source = pattern
    .split(/(\{[a-z]+\})/)
    .map((part) => {
      if (part === "{repo}") return "[^/]+/[^/]+";
      if (part === "{path}") return ".+";
      if (part.startsWith("{")) return "[^/]+";
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`);
}

const REGEXES = ENDPOINTS.map((endpoint) => patternRegex(endpoint.pattern));

/** The entry for a real request such as `repos/o/r/pulls/4/files?page=2`. */
export function endpointFor(
  method: string,
  endpoint: string,
): Endpoint | undefined {
  const path = endpoint.replace(/\?.*$/, "").replace(/^\/+/, "");
  const index = ENDPOINTS.findIndex(
    (candidate, at) => candidate.method === method && REGEXES[at]!.test(path),
  );
  return index === -1 ? undefined : ENDPOINTS[index];
}

function accessLabel(level: Level | undefined): string {
  return level === "write" ? "Read and write" : "Read";
}

/** `who` is what the failing credential is called in the sentence. */
export function refusalHint(
  method: string,
  endpoint: string,
  who: "token" | "App",
): string {
  const base = `GitHub refused ${method} ${endpoint}.`;
  const found = endpointFor(method, endpoint);
  if (!found?.permission) return base;
  if (who === "token" && !found.identities.includes("pat")) {
    return `${base} Only a GitHub App can do this.`;
  }
  const name = who === "token" ? "The token" : "The GitHub App";
  return `${base} ${name} needs ${PERMISSION_LABEL[found.permission]}: ${accessLabel(found.level)}.`;
}

export function missingHint(
  method: string,
  endpoint: string,
  who: "token" | "App",
): string {
  const name = who === "token" ? "the token" : "the GitHub App";
  const found = endpointFor(method, endpoint);
  const base = `GitHub returned 404 for ${method} ${endpoint}. The repository may not exist or ${name} cannot see it.`;
  if (!found?.permission) return base;
  return `${base} It also needs ${PERMISSION_LABEL[found.permission]}: ${accessLabel(found.level)}.`;
}

/** Classic scopes cover every repository call above, for `gh` and a classic
 * PAT alike. No scope is finer than that. */
const SCOPES: readonly { scope: string; why: string }[] = [
  { scope: "repo", why: "Read public and private repositories" },
  { scope: "public_repo", why: "Read public repositories only" },
];

export type TableKind = "app" | "pat-fine" | "pat-classic" | "gh" | "oauth";

function rows(header: string[], body: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [
    line(header),
    line(header.map((cell) => "-".repeat(Math.max(3, cell.length)))),
    ...body.map(line),
  ].join("\n");
}

function byPermission(identity: Identity, why: string): string {
  const strong = strongest(identity);
  return rows(
    identity === "app"
      ? ["Permission", "Access", why]
      : ["Repository permission", "Access", why],
    ORDER.filter((name) => strong[name]).map((name) => [
      PERMISSION_LABEL[name],
      accessLabel(strong[name]!.level),
      [...new Set(strong[name]!.features)]
        .map((text, at) =>
          at === 0 ? text : text[0]!.toLowerCase() + text.slice(1),
        )
        .join(", "),
    ]),
  );
}

/** A markdown table for the docs. `build_docs.ts` writes it between the
 * `permissions:<kind>` markers and a test fails when the page is stale. */
export function permissionTable(kind: TableKind): string {
  if (kind === "app") return byPermission("app", "Why");
  if (kind === "pat-fine") return byPermission("pat", "Needed for");
  if (kind === "oauth") {
    return rows(
      ["Scope", "Why"],
      [
        [
          "None requested",
          "The sign-in only reads your GitHub login from `GET /user`",
        ],
      ],
    );
  }
  return rows(
    ["Scope", "Why"],
    SCOPES.map(({ scope, why }) => [`\`${scope}\``, why]),
  );
}
