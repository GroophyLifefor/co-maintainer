/** `--ai=openai-compatible`: any server that speaks OpenAI Chat Completions
 * at its own address. Azure OpenAI, Amazon Bedrock, Gemini and local servers
 * such as Ollama all do. A preset only fills the address. */
import { readConfig, type UserConfig, writeUserConfig } from "../config.ts";
import type { AiMessage, AiRequest, Json } from "../types.ts";
import type { ChatHost } from "./openrouter.ts";
import { checkEgress, egressGuardActive, guardedDispatcher } from "./egress.ts";
import { aiTimeoutMs } from "./timeout.ts";

export const AI_PRESETS = ["azure", "bedrock", "gemini", "ollama"] as const;
export type AiPreset = (typeof AI_PRESETS)[number];

/** The base URL a preset stands for. Azure needs the resource name and
 * Bedrock the region, both checked so they cannot change the host. */
export function presetBaseUrl(
  preset: string,
  opts: { resource?: string; region?: string } = {},
): { ok: true; url: string } | { ok: false; problem: string } {
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
  switch (preset) {
    case "azure": {
      const resource = opts.resource?.trim() ?? "";
      if (!label.test(resource)) {
        return {
          ok: false,
          problem:
            "--ai-preset=azure needs --ai-resource=NAME, the Azure OpenAI resource name: letters, digits and hyphens",
        };
      }
      return {
        ok: true,
        url: `https://${resource}.openai.azure.com/openai/v1`,
      };
    }
    case "bedrock": {
      const region = opts.region?.trim() ?? "";
      if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) {
        return {
          ok: false,
          problem:
            "--ai-preset=bedrock needs --ai-region=REGION, an AWS region such as us-east-1",
        };
      }
      return { ok: true, url: `https://bedrock-mantle.${region}.api.aws/v1` };
    }
    case "gemini":
      return {
        ok: true,
        url: "https://generativelanguage.googleapis.com/v1beta/openai",
      };
    case "ollama":
      return { ok: true, url: "http://localhost:11434/v1" };
    default:
      return {
        ok: false,
        problem: `--ai-preset must be one of: ${AI_PRESETS.join(", ")}`,
      };
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}

export type ParsedBaseUrl = {
  /** The base without a trailing slash or `/chat/completions`. */
  base: string;
  /** Where requests go. */
  endpoint: string;
  /** http to a host that is not this machine, allowed only on request. The
   * key is never sent there. */
  plainRemote: boolean;
};

/** Reads `--ai-base-url`. A trailing `/` or `/chat/completions` is cleaned.
 * User info and a query are refused, so a key cannot ride in the address and
 * the endpoint is exactly what it says. http is for this machine, or for
 * another host only with `allowHttp`. */
export function parseAiBaseUrl(
  raw: string,
  opts: { allowHttp?: boolean } = {},
): { ok: true; value: ParsedBaseUrl } | { ok: false; problem: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, problem: `--ai-base-url is not an address: ${raw}` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      ok: false,
      problem: "--ai-base-url must be an http or https address",
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      problem:
        "--ai-base-url must not carry a user name or password. Pass the key with --ai-key",
    };
  }
  if (url.search || url.hash) {
    return {
      ok: false,
      problem: "--ai-base-url must not have a query or a fragment",
    };
  }
  const local = isLocalHost(url.hostname);
  if (url.protocol === "http:" && !local && !opts.allowHttp) {
    return {
      ok: false,
      problem:
        "--ai-base-url uses http to another machine. Use https, or pass --ai-allow-http, and then no key is sent",
    };
  }
  const path = url.pathname
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/, "");
  const base = `${url.origin}${path}`;
  return {
    ok: true,
    value: {
      base,
      endpoint: `${base}/chat/completions`,
      plainRemote: url.protocol === "http:" && !local,
    },
  };
}

// The provider itself.

/** Body fields a server may refuse. Each is dropped once, on its own. */
export const DROPPABLE = [
  "max_completion_tokens",
  "temperature",
  "reasoning_effort",
  "response_format",
] as const;
type Droppable = (typeof DROPPABLE)[number];

/** Chat Completions as most compatible servers take it. A dropped
 * `max_completion_tokens` falls back to `max_tokens`. */
export function compatibleBody(
  model: string,
  request: AiRequest,
  drop: ReadonlySet<string>,
): Json {
  const messages: AiMessage[] = request.messages ?? [
    ...(request.system
      ? [{ role: "system" as const, content: request.system }]
      : []),
    { role: "user" as const, content: request.prompt },
  ];
  return {
    model,
    messages,
    ...(drop.has("max_completion_tokens")
      ? { max_tokens: request.maxTokens }
      : { max_completion_tokens: request.maxTokens }),
    ...(drop.has("temperature") ? {} : { temperature: 0 }),
    ...(request.reasoningEffort && !drop.has("reasoning_effort")
      ? { reasoning_effort: request.reasoningEffort }
      : {}),
    ...(request.tools?.length
      ? { tools: request.tools, tool_choice: "auto" }
      : {}),
    ...(request.responseFormat && !drop.has("response_format")
      ? { response_format: request.responseFormat }
      : {}),
  };
}

/** The field a 400 or 422 refused, if it names one not dropped yet. */
export function refusedField(
  detail: string,
  drop: ReadonlySet<string>,
): Droppable | undefined {
  const patterns: Record<Droppable, RegExp> = {
    max_completion_tokens: /max_completion_tokens/i,
    temperature: /temperature/i,
    reasoning_effort: /reasoning_effort|reasoning/i,
    response_format: /response_format|json_schema|structured/i,
  };
  return DROPPABLE.find(
    (field) => !drop.has(field) && patterns[field].test(detail),
  );
}

/** Lessons are written one after another. Two writes in flight can finish in
 * either order, and an older, smaller lesson that lands last would erase the
 * newer one. Each write also reads the set when its turn comes, not when it
 * was asked for, so the last write always holds everything learned. */
let lessons: Promise<void> = Promise.resolve();

/** Saves what a model refused, so later requests leave it out from the
 * start. Only while the base URL is the one the lesson came from. A failed
 * write never fails the review. */
function remember(
  baseUrl: string,
  model: string,
  drop: ReadonlySet<string>,
): Promise<void> {
  lessons = lessons.then(async () => {
    try {
      const config = readConfig();
      if (config.aiBaseUrl !== baseUrl) return;
      const quirks = { ...config.aiModelQuirks };
      quirks[model] = { ...quirks[model], drop: [...drop].sort() };
      await writeUserConfig({ aiModelQuirks: quirks });
    } catch {
      // Learning again next time costs one retry.
    }
  });
  return lessons;
}

export type CompatibleSettings = Pick<
  UserConfig,
  "aiBaseUrl" | "aiAllowHttp" | "aiModelQuirks"
>;

/** The host for `openai-compatible`, from the saved base URL. */
export function openAiCompatibleHost(
  model: string,
  settings: CompatibleSettings = readConfig(),
): ChatHost {
  const raw = settings.aiBaseUrl ?? "";
  const parsed = parseAiBaseUrl(raw, { allowHttp: settings.aiAllowHttp });
  if (!parsed.ok) {
    throw new Error(
      raw
        ? `The openai-compatible base URL is not usable: ${parsed.problem}`
        : "openai-compatible needs a base URL. Set it with co-maintainer set --ai-base-url=... or --ai-preset=...",
    );
  }
  const { base, endpoint, plainRemote } = parsed.value;
  const learned = settings.aiModelQuirks?.[model];
  const drop = new Set<string>(learned?.drop ?? []);
  return {
    provider: "openai-compatible",
    name: `The AI server at ${new URL(endpoint).host}`,
    code: "openai_compatible",
    endpoint,
    headers: {},
    modelHint:
      "Use the model or deployment name your endpoint expects, and set it with co-maintainer set --high-model=...",
    keyHint: "Set the key with co-maintainer set --ai-key=...",
    keyOptional: true,
    sendKey: !plainRemote,
    notFoundIsUnknownModel: true,
    jsonErrorOnly: true,
    supportsTools: learned?.tools ?? true,
    body: (name, request) => compatibleBody(name, request, drop),
    lighter: (request, detail, status) => {
      if (status !== 400 && status !== 422) return undefined;
      const field = refusedField(detail, drop);
      if (!field) return undefined;
      drop.add(field);
      void remember(base, model, drop);
      return request;
    },
    preflight: checkEgress,
    init: () => ({
      redirect: "error",
      ...(egressGuardActive()
        ? ({
            dispatcher: guardedDispatcher(aiTimeoutMs()),
          } as unknown as RequestInit)
        : {}),
    }),
  };
}

/** One small request with a `ping` tool, so `set` and the dashboard learn
 * whether the address, key and model work and whether the model takes
 * tools. Under 300 tokens. A refused key or model is `rejected`. A server
 * that refuses tools still works: `tools` is false, and reviews run
 * without them. */
export async function verifyCompatible(
  key: string,
  model: string | undefined,
  settings: CompatibleSettings,
): Promise<
  | { status: "ok"; tools?: boolean }
  | { status: "unreachable"; reason: string }
  | { status: "rejected"; error: import("../cli/error.ts").CliError }
> {
  const { CliError } = await import("../cli/error.ts");
  const { OpenRouterProvider } = await import("./openrouter.ts");
  if (!model) return { status: "ok" };
  let host: ChatHost;
  try {
    host = openAiCompatibleHost(model, {
      ...settings,
      aiModelQuirks: undefined,
    });
  } catch (error) {
    return {
      status: "rejected",
      error: new CliError(
        "openai_compatible_base_url",
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
  const provider = new OpenRouterProvider(key, model, host);
  const ping = {
    type: "function",
    function: {
      name: "ping",
      description: "Answers pong.",
      parameters: { type: "object", properties: {} },
    },
  };
  const ask = (tools: boolean) =>
    provider.complete({
      prompt: tools ? "Call the ping tool once." : "Reply with the word ok.",
      maxTokens: 200,
      job: "verify_ai_key",
      ...(tools ? { tools: [ping] } : {}),
    });
  try {
    const answer = await ask(true);
    return {
      status: "ok",
      ...(answer.toolCalls?.length ? { tools: true } : {}),
    };
  } catch (error) {
    if (error instanceof CliError) {
      // Asked first: "tools are not supported by this model" names a model
      // too, and the model is fine without tools.
      if (
        /tool/i.test(error.message) &&
        !/unauthorized|redirect/.test(error.code)
      ) {
        try {
          await ask(false);
          return { status: "ok", tools: false };
        } catch (second) {
          if (
            second instanceof CliError &&
            /unauthorized|unknown_model/.test(second.code)
          ) {
            return { status: "rejected", error: second };
          }
          return {
            status: "unreachable",
            reason: second instanceof Error ? second.message : String(second),
          };
        }
      }
      if (/unauthorized|unknown_model|redirect/.test(error.code)) {
        return { status: "rejected", error };
      }
    }
    return {
      status: "unreachable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
