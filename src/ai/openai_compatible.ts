/** `--ai=openai-compatible`: any server that speaks OpenAI Chat Completions
 * at its own address. Azure OpenAI, Amazon Bedrock, Gemini and local servers
 * such as Ollama all do. A preset only fills the address. */

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
