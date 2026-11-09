/** A fake of the GitHub REST API, for the commit watch smoke test.
 *
 * It answers like GitHub for the calls a push review makes as the App: the
 * installation list and token, compare, contents, commits, issues, issue
 * comments, labels and check runs. The repository data comes from a real
 * bare git repository, so compare and contents are what git says, not
 * fixtures. Issues, comments and check runs live in memory, and a test
 * reads them back from `state`.
 *
 * Point the server at it with `CM_GITHUB_API_URL`. */
import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";

export type FakeIssue = {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
  closedBy: "bot" | "user" | null;
  comments: { id: number; body: string; user: string }[];
};

export type FakeCheckRun = {
  id: number;
  head_sha: string;
  name: string;
  status: string;
  conclusion: string | null;
  output: { title?: string; summary?: string; annotations?: unknown[] } | null;
};

export type FakeGithubState = {
  issues: FakeIssue[];
  labels: Set<string>;
  checkRuns: FakeCheckRun[];
  requests: { method: string; path: string }[];
  /** The installation's webhook events. `push` turns commit watch on. */
  events: string[];
  /** When true, closing an issue answers 403, like an App without the
   * permission. */
  closeDenied: boolean;
  /** Logins whose repository permission is read. Everyone else can write. */
  readOnly: Set<string>;
};

export type FakeGithub = {
  url: string;
  state: FakeGithubState;
  /** A maintainer closes an issue by hand. */
  closeAsUser(number: number): void;
  reopen(number: number): void;
  stop(): Promise<void>;
};

const INSTALLATION_ID = 1;

function git(bare: string, args: string[]): string {
  const result = spawnSync("git", ["-C", bare, ...args], { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/** GitHub's compare `files`, from `git diff`. */
function compareFiles(bare: string, base: string, head: string) {
  const status = git(bare, ["diff", "--name-status", "-M", base, head])
    .split("\n")
    .filter(Boolean);
  return status.map((line) => {
    const [code, first, second] = line.split("\t");
    const path = second ?? first!;
    const patchText = git(bare, [
      "diff",
      "--unified=3",
      "-M",
      base,
      head,
      "--",
      ...(second ? [first!, second] : [path]),
    ]);
    // GitHub's `patch` starts at the first hunk, without the diff header.
    const patch = patchText.split("\n");
    const start = patch.findIndex((l) => l.startsWith("@@"));
    const body =
      start === -1 ? "" : patch.slice(start).join("\n").replace(/\n$/, "");
    const additions = body.split("\n").filter((l) => l.startsWith("+")).length;
    const deletions = body.split("\n").filter((l) => l.startsWith("-")).length;
    return {
      filename: path,
      previous_filename: second ? first : undefined,
      status: code!.startsWith("A")
        ? "added"
        : code!.startsWith("D")
          ? "removed"
          : code!.startsWith("R")
            ? "renamed"
            : "modified",
      additions,
      deletions,
      changes: additions + deletions,
      patch: body,
    };
  });
}

export async function startFakeGithub(opts: {
  /** Every repository the installation covers. They all read `bare`. */
  repos: string[];
  bare: string;
  events?: string[];
}): Promise<FakeGithub> {
  const state: FakeGithubState = {
    issues: [],
    labels: new Set(),
    checkRuns: [],
    requests: [],
    events: opts.events ?? ["pull_request", "issue_comment", "push"],
    closeDenied: false,
    readOnly: new Set(),
  };
  let nextId = 1000;

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fake");
    const path = url.pathname;
    const method = request.method ?? "GET";
    state.requests.push({ method, path: `${path}${url.search}` });
    const send = (status: number, body?: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body === undefined ? "" : JSON.stringify(body));
    };
    try {
      if (method === "GET" && path === "/app/installations") {
        return send(200, [
          {
            id: INSTALLATION_ID,
            account: { login: opts.repos[0]!.split("/")[0], type: "User" },
            suspended_at: null,
            permissions: { issues: "write", checks: "write", contents: "read" },
            events: state.events,
          },
        ]);
      }
      if (
        method === "POST" &&
        path === `/app/installations/${INSTALLATION_ID}/access_tokens`
      ) {
        return send(201, {
          token: "ghs_fake",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (method === "GET" && path === "/installation/repositories") {
        return send(200, {
          repositories: opts.repos.map((full_name) => ({
            full_name,
            private: false,
          })),
        });
      }
      const repo = opts.repos.find((name) => path.startsWith(`/repos/${name}`));
      if (!repo) return send(404, { message: "Not Found" });
      const rest = path.slice(`/repos/${repo}`.length);

      let match = /^\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(rest);
      if (method === "GET" && match) {
        const base = git(opts.bare, [
          "merge-base",
          match[1]!,
          match[2]!,
        ]).trim();
        return send(200, { files: compareFiles(opts.bare, base, match[2]!) });
      }
      match = /^\/contents\/(.+)$/.exec(rest);
      if (method === "GET" && match) {
        const file = decodeURIComponent(match[1]!);
        const ref = url.searchParams.get("ref") ?? "HEAD";
        try {
          const content = git(opts.bare, ["show", `${ref}:${file}`]);
          return send(200, {
            path: file,
            encoding: "base64",
            content: Buffer.from(content).toString("base64"),
          });
        } catch {
          return send(404, { message: "Not Found" });
        }
      }
      match = /^\/collaborators\/([^/]+)\/permission$/.exec(rest);
      if (method === "GET" && match) {
        const role = state.readOnly.has(decodeURIComponent(match[1]!))
          ? "read"
          : "write";
        return send(200, { permission: role, role_name: role });
      }
      if (method === "GET" && rest === "/commits") {
        const sha = url.searchParams.get("sha") ?? "HEAD";
        const file = url.searchParams.get("path");
        const out = git(opts.bare, [
          "log",
          "-1",
          "--format=%H",
          sha,
          ...(file ? ["--", file] : []),
        ]).trim();
        return send(200, out ? [{ sha: out }] : []);
      }
      if (method === "POST" && rest === "/labels") {
        const body = (await readBody(request)) as { name?: string };
        const name = String(body.name ?? "");
        if (state.labels.has(name))
          return send(422, { message: "Validation Failed" });
        state.labels.add(name);
        return send(201, { name });
      }
      if (method === "POST" && rest === "/issues") {
        const body = (await readBody(request)) as {
          title?: string;
          body?: string;
          labels?: string[];
        };
        const issue: FakeIssue = {
          number: state.issues.length + 1,
          title: String(body.title ?? ""),
          body: String(body.body ?? ""),
          labels: body.labels ?? [],
          state: "open",
          closedBy: null,
          comments: [],
        };
        state.issues.push(issue);
        return send(201, { number: issue.number, id: nextId++ });
      }
      match = /^\/issues\/(\d+)(\/comments)?$/.exec(rest);
      if (match) {
        const issue = state.issues.find((i) => i.number === Number(match![1]));
        if (!issue) return send(404, { message: "Not Found" });
        if (match[2] && method === "POST") {
          const body = (await readBody(request)) as { body?: string };
          const comment = {
            id: nextId++,
            body: String(body.body ?? ""),
            user: "co-maintainer[bot]",
          };
          issue.comments.push(comment);
          return send(201, { id: comment.id });
        }
        if (match[2] && method === "GET") {
          return send(
            200,
            issue.comments.map((c) => ({
              id: c.id,
              body: c.body,
              user: { login: c.user },
            })),
          );
        }
        if (method === "GET") {
          return send(200, {
            number: issue.number,
            state: issue.state,
            closed_by:
              issue.closedBy === "bot"
                ? { login: "co-maintainer[bot]", type: "Bot" }
                : issue.closedBy === "user"
                  ? { login: "maintainer", type: "User" }
                  : null,
          });
        }
        if (method === "PATCH") {
          if (state.closeDenied)
            return send(403, {
              message: "Resource not accessible by integration",
            });
          const body = (await readBody(request)) as { state?: string };
          if (body.state === "closed") {
            issue.state = "closed";
            issue.closedBy = "bot";
          }
          return send(200, { number: issue.number, state: issue.state });
        }
      }
      if (method === "POST" && rest === "/check-runs") {
        const body = (await readBody(request)) as Partial<FakeCheckRun>;
        const run: FakeCheckRun = {
          id: nextId++,
          head_sha: String(body.head_sha ?? ""),
          name: String(body.name ?? ""),
          status: String(body.status ?? "queued"),
          conclusion: (body.conclusion as string | undefined) ?? null,
          output: (body.output as FakeCheckRun["output"]) ?? null,
        };
        state.checkRuns.push(run);
        return send(201, { id: run.id });
      }
      match = /^\/check-runs\/(\d+)$/.exec(rest);
      if (method === "PATCH" && match) {
        const run = state.checkRuns.find((r) => r.id === Number(match![1]));
        if (!run) return send(404, { message: "Not Found" });
        const body = (await readBody(request)) as Partial<FakeCheckRun>;
        if (body.status) run.status = body.status;
        if (body.conclusion) run.conclusion = body.conclusion;
        if (body.output) run.output = body.output;
        return send(200, { id: run.id });
      }
      if (method === "GET" && rest === "") {
        return send(200, { full_name: repo, default_branch: "main" });
      }
      return send(404, { message: "Not Found" });
    } catch (error) {
      return send(500, { message: String(error) });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    closeAsUser(number) {
      const issue = state.issues.find((i) => i.number === number);
      if (issue) {
        issue.state = "closed";
        issue.closedBy = "user";
      }
    },
    reopen(number) {
      const issue = state.issues.find((i) => i.number === number);
      if (issue) {
        issue.state = "open";
        issue.closedBy = null;
      }
    },
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
