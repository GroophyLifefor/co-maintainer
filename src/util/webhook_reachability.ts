/** Why GitHub cannot deliver webhooks to this URL, or `undefined` when the
 * host looks reachable from the public internet.
 *
 * `serve` accepts any absolute http(s) URL because a single-label internal
 * host (Docker Compose, k8s) or an IPv6 literal is legitimate for other
 * callers. For GitHub's webhook deliveries they are not: localhost and the
 * private ranges below are unreachable from outside, and a fresh install
 * defaults to `http://localhost:<port>/github/webhook`, so the most common
 * first-run mistake is silent otherwise. This only classifies the host, it
 * never rejects a URL: `set` and `serve` keep accepting them. */
export function webhookReachabilityProblem(
  webhookUrl: string,
): string | undefined {
  let host: string;
  try {
    host = new URL(webhookUrl).hostname;
  } catch {
    return "The webhook URL is not a valid absolute URL.";
  }
  // `URL` keeps IPv6 literals in brackets.
  const bare =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const lower = bare.toLowerCase();

  if (lower === "localhost" || lower.endsWith(".localhost")) {
    return "localhost only resolves on the machine running serve.";
  }
  if (lower === "0.0.0.0" || lower === "::" || lower === "::1") {
    return `${bare} only resolves on the machine running serve.`;
  }
  if (lower.startsWith("127.")) {
    return "A loopback address only resolves on the machine running serve.";
  }
  if (isPrivateIpv4(lower)) {
    return `${bare} is a private network address, not one GitHub can route to.`;
  }
  if (isPrivateIpv6(lower)) {
    return `${bare} is a private network address, not one GitHub can route to.`;
  }
  return undefined;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return false;
  }
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Link-local, as in the 169.254.169.254 metadata address.
  if (a === 169 && b === 254) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  if (!host.includes(":")) return false;
  // Unique local (fc00::/7) and link-local (fe80::/10).
  return /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
}
