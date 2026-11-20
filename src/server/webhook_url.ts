/** The webhook URL every surface shows: the `--webhook-url` flag or
 * `CM_WEBHOOK_URL`, then the saved value, then the default. `serve` resolves
 * the same order when it starts. The dashboard used to put the saved value
 * first, so the console, the setup checklist and the App manifest could name
 * two different URLs. */
export type WebhookUrlSource = {
  /** The default, `http://localhost:<port>/github/webhook`. */
  webhookUrl?: string;
  /** The flag or the environment variable, fixed for the process. */
  webhookUrlOverride?: string;
  /** Which of the two set the override, for the dashboard's lock note. */
  webhookUrlOverrideName?: string;
};

/** A plain string is a default only, as tests and older callers pass it. */
export function liveWebhookUrl(
  config: { webhookUrl?: string },
  source: string | WebhookUrlSource | undefined,
): string {
  const deps: WebhookUrlSource =
    typeof source === "string" ? { webhookUrl: source } : (source ?? {});
  return deps.webhookUrlOverride || config.webhookUrl || deps.webhookUrl || "";
}

/** What is wrong with a webhook URL, or undefined. `serve` refuses to start
 * on the same problems, so the dashboard must refuse to save them. */
export function webhookUrlProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "webhook URL must be an absolute http(s) URL, e.g. https://example.com/github/webhook";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "webhook URL must use http or https";
  }
  // `new URL` is lenient: "http://http://host/:5000/x" parses with host
  // "http" and the real URL buried in the path, and "http:///x" treats "x"
  // as the host. GitHub needs a routable host and a real webhook path, so
  // reject a leaked scheme, an empty authority, and a path that is just "/".
  // A single-label host (an internal Docker/k8s name) or an IPv6 literal is
  // legitimate, and both are indistinguishable from the "http:///x" spelling
  // once parsed, so the empty authority is caught on the raw string instead.
  const hasAuthority = /^https?:\/\/[^/?#]+/.test(raw.trim());
  if (
    !hasAuthority ||
    url.pathname.startsWith("//") ||
    url.pathname.includes("://") ||
    url.pathname === "/"
  ) {
    return "webhook URL must be an absolute http(s) URL with a webhook path, e.g. https://example.com/github/webhook";
  }
  return undefined;
}
