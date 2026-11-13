/** The network as `e2e:simulate` sees it.
 *
 * `globalThis.fetch` is replaced in this process. Every product call to GitHub
 * (the App client, the PAT client) goes through it, so the simulated GitHub
 * answers from the repositories in the world, with no socket opened. AI calls
 * go through the same fetch: without `--ai` the flow's fake AI script answers
 * them, with it they pass to the real provider. The simulated remote server's
 * host is answered by the real remote routes, in this process. Anything else
 * is refused and recorded as a leak, so a run can never reach the network by
 * accident. A fault a flow asked for is applied here before the answer. */
import { promptOf } from "../fake_openrouter.ts";
import { currentAiJob } from "./ai_watch.ts";
import type { FakeAi } from "./fake_ai.ts";
import {
  describeFault,
  type Fault,
  type Faults,
  sleep,
  timeoutError,
} from "./faults.ts";
import type { Trace } from "./trace.ts";
import { AI_HOSTS, type World } from "./world.ts";

const AI_HOST_SET = new Set(AI_HOSTS);

/** The trace keeps no minted installation token: the product needs it in
 * the answer, the report does not. */
function traced(url: URL, response: unknown): unknown {
  if (!/\/access_tokens$/.test(url.pathname)) return response;
  return { ...(response as Record<string, unknown>), token: "[minted]" };
}

/** The simulated remote server. `.test` is reserved, so it can never be a
 * real host. */
export const REMOTE_HOST = "remote.simulate.test";
export const REMOTE_URL = `https://${REMOTE_HOST}`;

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
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

/** A response whose body stops after `text`, the way a dropped connection
 * looks to `fetch`: reading it rejects with a `TypeError`. */
function cutResponse(body: unknown, text: string): Response {
  const full = JSON.stringify(body);
  const end = full.indexOf(JSON.stringify(text).slice(1, -1));
  const sent = full.slice(0, end < 0 ? full.length >> 1 : end + text.length);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sent));
      controller.error(
        new TypeError("terminated", {
          cause: { code: "UND_ERR_SOCKET", message: "other side closed" },
        }),
      );
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** What a GitHub or remote fault answers with. */
function faultResponse(fault: Fault, label: string): Response {
  if (fault.kind === "404") return json(404, { message: "Not Found", label });
  if (fault.kind === "500") {
    return json(500, { message: "Server Error", label });
  }
  // A primary limit at zero that resets now: GitHub's client retries at once.
  return json(
    403,
    { message: "API rate limit exceeded", label },
    {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000)),
    },
  );
}

function aiFaultResponse(fault: Fault, label: string): Response {
  const status = fault.kind === "404" ? 404 : fault.kind === "500" ? 500 : 429;
  const message =
    fault.kind === "rate-limit" ? "Rate limit exceeded" : `HTTP ${status}`;
  return json(status, { error: { message, label } });
}

function bearer(headers: Headers): string | undefined {
  const value = headers.get("authorization") ?? "";
  return /^(?:Bearer|token)\s+(.+)$/i.exec(value)?.[1];
}

export type FetchOptions = {
  world: World;
  trace: Trace;
  /** `live` passes AI calls to the real provider; `fake` answers them here. */
  ai: "fake" | "live";
  fakeAi: FakeAi;
  faults: Faults;
};

/** Replaces `globalThis.fetch` until the returned function is called. */
export function installFetch({
  world,
  trace,
  ai,
  fakeAi,
  faults,
}: FetchOptions): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers);
    const rawBody =
      init?.body ??
      (request && method !== "GET" ? await request.clone().text() : null);
    const body = parseBody(rawBody);
    const started = performance.now();
    const startMs = trace.now();
    const step = trace.step;
    const ms = () => Math.round(performance.now() - started);
    // Which secret each request carried in a header, by name. The leak check
    // holds every secret to its own hosts.
    const headerText = [...headers.values()].join("\n");
    for (const secret of world.secretValues()) {
      if (headerText.includes(secret.value)) {
        trace.credentials.push({
          step,
          startMs,
          host: url.hostname,
          secret: secret.name,
        });
      }
    }

    if (url.hostname === "api.github.com") {
      const fault = faults.take(
        { target: "github", method, path: url.pathname },
        step,
      );
      if (fault?.kind === "slow") await sleep(fault.ms ?? 50);
      else if (fault) {
        const record = {
          step,
          startMs,
          method,
          url: url.toString(),
          request: body,
          handled: true,
          via: "fetch" as const,
          fault: fault.kind,
        };
        if (fault.kind === "timeout") {
          trace.github.push({ ...record, status: 0, ms: ms(), response: null });
          throw timeoutError();
        }
        const response = faultResponse(fault, describeFault(fault));
        trace.github.push({
          ...record,
          status: response.status,
          ms: ms(),
          response: await response.clone().json(),
        });
        return response;
      }
      const route = world.github.route({
        method,
        url,
        body,
        via: "fetch",
        token: bearer(headers),
        step,
      });
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
        ms: ms(),
        request: body,
        response: traced(url, response),
        handled: route !== undefined,
        via: "fetch",
      });
      return json(status, response, route?.headers);
    }

    if (AI_HOST_SET.has(url.hostname)) {
      const job = currentAiJob();
      const prompt =
        body && typeof body === "object"
          ? promptOf(body as Record<string, unknown>)
          : "";
      const fault = faults.take(
        { target: "ai", method, path: url.pathname, job, prompt },
        step,
      );
      const base = { step, startMs, method, url: url.toString(), job };
      if (fault?.kind === "slow") await sleep(fault.ms ?? 50);
      else if (fault) {
        const mode = ai;
        if (fault.kind === "timeout") {
          trace.ai.push({
            ...base,
            mode,
            status: 0,
            ms: ms(),
            request: body,
            response: null,
            fault: fault.kind,
          });
          throw timeoutError();
        }
        const response = aiFaultResponse(fault, describeFault(fault));
        trace.ai.push({
          ...base,
          mode,
          status: response.status,
          ms: ms(),
          request: body,
          response: await response.clone().json(),
          fault: fault.kind,
        });
        return response;
      }
      if (ai === "live") {
        const response = await original(input, init);
        const text = await response.clone().text();
        trace.ai.push({
          ...base,
          mode: "live",
          status: response.status,
          ms: ms(),
          request: body,
          response: parseBody(text),
        });
        return response;
      }
      if (url.hostname === "openrouter.ai") {
        if (method === "GET" && url.pathname.endsWith("/models")) {
          trace.ai.push({
            ...base,
            mode: "fake",
            status: 200,
            ms: ms(),
            request: body,
            response: { data: [] },
            rule: "models",
          });
          return json(200, { data: [] });
        }
        if (method === "POST" && url.pathname.endsWith("/chat/completions")) {
          const answer = fakeAi.answer(
            (body ?? {}) as Record<string, unknown>,
            job,
          );
          trace.ai.push({
            ...base,
            mode: "fake",
            status: answer.status,
            ms: ms(),
            request: body,
            response: answer.body,
            ...(answer.rule === undefined
              ? { unscripted: true }
              : { rule: answer.rule }),
          });
          return answer.cutOff === undefined
            ? json(answer.status, answer.body)
            : cutResponse(answer.body, answer.cutOff);
        }
      }
    }

    if (url.hostname === REMOTE_HOST) {
      const fault = faults.take(
        { target: "remote", method, path: url.pathname },
        step,
      );
      const base = {
        step,
        startMs,
        method,
        url: url.toString(),
        request: body,
      };
      if (fault?.kind === "slow") await sleep(fault.ms ?? 50);
      else if (fault) {
        if (fault.kind === "timeout") {
          trace.remote.push({
            ...base,
            status: 0,
            ms: ms(),
            response: null,
            fault: fault.kind,
          });
          throw timeoutError();
        }
        const response = faultResponse(fault, describeFault(fault));
        trace.remote.push({
          ...base,
          status: response.status,
          ms: ms(),
          response: await response.clone().json(),
          fault: fault.kind,
        });
        return response;
      }
      const { handleRemoteRoute } =
        await import("../../remote/server/routes.ts");
      const response = await handleRemoteRoute(
        new Request(url, { method, headers, body: rawBody }),
        url,
        "127.0.0.1",
      );
      trace.remote.push({
        ...base,
        status: response.status,
        ms: ms(),
        response: parseBody(await response.clone().text()),
      });
      return response;
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
