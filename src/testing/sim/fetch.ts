/** The network as `e2e:simulate` sees it.
 *
 * `globalThis.fetch` is replaced in this process. Every product call to GitHub
 * (the App client, the PAT client) goes through it, so the simulated GitHub
 * answers from the repositories in the world, with no socket opened. AI calls
 * go through the same fetch: without `--ai` the fake AI answers them, with it
 * they pass to the real provider. Anything else is refused and recorded as a
 * leak, so a run can never reach the network by accident. */
import { fakeChatCompletion } from "./fake_ai.ts";
import type { Trace } from "./trace.ts";
import type { SimRepo, World } from "./world.ts";

const AI_HOSTS = new Set([
  "openrouter.ai",
  "api.openai.com",
  "api.anthropic.com",
  "opencode.ai",
]);

type Route = { status: number; body: unknown } | undefined;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") return body ?? null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/** The GitHub REST routes a codebase-only `init` makes. A call with no route
 * here returns 404 and is recorded as unhandled, which fails a check: the
 * product can swallow a 404 (a missing file is not an error), the check
 * cannot. */
function githubRoute(world: World, method: string, url: URL): Route {
  if (method !== "GET") return undefined;
  const match = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(url.pathname);
  const repo = match
    ? world.repos.get(decodeURIComponent(match[1]))
    : undefined;
  if (!match || !repo) return undefined;
  const rest = match[2] ?? "";
  if (rest === "") return { status: 200, body: repoJson(repo) };
  const tree = /^\/git\/trees\/(.+)$/.exec(rest);
  if (tree) return treeJson(world, repo, decodeURIComponent(tree[1]));
  const contents = /^\/contents\/(.+)$/.exec(rest);
  if (contents) {
    const path = contents[1].split("/").map(decodeURIComponent).join("/");
    const ref = url.searchParams.get("ref") ?? repo.defaultBranch;
    return contentsJson(world, repo, path, ref);
  }
  return undefined;
}

function repoJson(repo: SimRepo): unknown {
  const [owner, name] = repo.fullName.split("/");
  return {
    name,
    full_name: repo.fullName,
    owner: { login: owner },
    private: false,
    default_branch: repo.defaultBranch,
    description: "A repository simulated by e2e:simulate",
    html_url: `https://github.com/${repo.fullName}`,
  };
}

function treeJson(world: World, repo: SimRepo, ref: string): Route {
  let listing: string;
  try {
    listing = world.git(repo, ["ls-tree", "-r", "--full-tree", ref]).toString();
  } catch {
    return { status: 404, body: { message: "Not Found" } };
  }
  const tree = listing
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t");
      const [mode, type, sha] = meta.split(" ");
      return { path, mode, type, sha };
    });
  return { status: 200, body: { sha: ref, truncated: false, tree } };
}

function contentsJson(
  world: World,
  repo: SimRepo,
  path: string,
  ref: string,
): Route {
  try {
    const content = world.git(repo, ["show", `${ref}:${path}`]);
    return {
      status: 200,
      body: {
        type: "file",
        path,
        encoding: "base64",
        content: content.toString("base64"),
      },
    };
  } catch {
    return { status: 404, body: { message: "Not Found" } };
  }
}

/** The OpenRouter routes the fake AI answers. */
function fakeAiRoute(method: string, url: URL, body: unknown): Route {
  if (method === "POST" && url.pathname.endsWith("/chat/completions")) {
    return {
      status: 200,
      body: fakeChatCompletion((body ?? {}) as Record<string, unknown>),
    };
  }
  if (method === "GET" && url.pathname.endsWith("/models")) {
    return { status: 200, body: { data: [] } };
  }
  return undefined;
}

export type FetchOptions = {
  world: World;
  trace: Trace;
  /** `live` passes AI calls to the real provider; `fake` answers them here. */
  ai: "fake" | "live";
};

/** Replaces `globalThis.fetch` until the returned function is called. */
export function installFetch({ world, trace, ai }: FetchOptions): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const body = parseBody(init?.body);
    const started = performance.now();
    const startMs = trace.now();
    const step = trace.step;

    if (url.hostname === "api.github.com") {
      const route = githubRoute(world, method, url);
      const status = route?.status ?? 404;
      const response = route?.body ?? {
        message: `Not Found (e2e:simulate has no route for ${method} ${url.pathname})`,
      };
      trace.github.push({
        step,
        startMs,
        method,
        url: url.toString(),
        status,
        ms: Math.round(performance.now() - started),
        request: body,
        response,
        handled: route !== undefined,
      });
      return json(status, response);
    }

    if (AI_HOSTS.has(url.hostname)) {
      if (ai === "live") {
        const response = await original(input, init);
        const text = await response.clone().text();
        trace.ai.push({
          step,
          startMs,
          mode: "live",
          method,
          url: url.toString(),
          status: response.status,
          ms: Math.round(performance.now() - started),
          request: body,
          response: parseBody(text),
        });
        return response;
      }
      const route =
        url.hostname === "openrouter.ai"
          ? fakeAiRoute(method, url, body)
          : undefined;
      if (route) {
        trace.ai.push({
          step,
          startMs,
          mode: "fake",
          method,
          url: url.toString(),
          status: route.status,
          ms: Math.round(performance.now() - started),
          request: body,
          response: route.body,
        });
        return json(route.status, route.body);
      }
    }

    trace.leaks.push({ step, startMs, method, url: url.toString() });
    throw new TypeError(
      `e2e:simulate refused a network call to ${method} ${url.origin}${url.pathname}`,
    );
  };
  return () => {
    globalThis.fetch = original;
  };
}
