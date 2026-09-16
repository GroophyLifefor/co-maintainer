import { platformWarning, resolveAuthMethods, resolveWebhookUrl } from "./serve.ts";

Deno.test("resolveAuthMethods defaults to password only", () => {
  const auth = resolveAuthMethods([], {});
  if (!auth.password || auth.github) {
    throw new Error(`expected password-only, got ${JSON.stringify(auth)}`);
  }
});

Deno.test("resolveAuthMethods: config enables github, no flags needed", () => {
  const auth = resolveAuthMethods([], { githubAuthEnabled: true });
  if (!auth.password || !auth.github) {
    throw new Error(`expected both on, got ${JSON.stringify(auth)}`);
  }
});

Deno.test("resolveAuthMethods: a CLI flag always overrides its config default", () => {
  const auth = resolveAuthMethods(
    ["--disable-auth=password", "--enable-auth=github"],
    { githubAuthEnabled: false },
  );
  if (auth.password || !auth.github) {
    throw new Error(`expected github-only, got ${JSON.stringify(auth)}`);
  }
});

Deno.test("resolveAuthMethods dies when both methods end up off", () => {
  let threw = false;
  try {
    resolveAuthMethods(["--disable-auth=password"], {});
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected resolveAuthMethods to die");
});

Deno.test("resolveAuthMethods rejects an unknown --disable-auth value", () => {
  let threw = false;
  try {
    resolveAuthMethods(["--disable-auth=github"], {});
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected resolveAuthMethods to die");
});

Deno.test("platformWarning is silent on linux and speaks up everywhere else", () => {
  if (platformWarning("linux") !== undefined) {
    throw new Error("linux should have no warning");
  }
  for (const os of ["windows", "darwin"] as const) {
    const warning = platformWarning(os);
    if (!warning?.includes(os)) {
      throw new Error(`expected a warning naming ${os}, got ${warning}`);
    }
  }
});

Deno.test("resolveWebhookUrl prefers the CLI URL and accepts public http(s)", () => {
  const url = resolveWebhookUrl(
    ["--webhook-url=https://example.com/github/webhook"],
    5000,
  );
  if (url !== "https://example.com/github/webhook") {
    throw new Error(`unexpected webhook URL: ${url}`);
  }
});

Deno.test("resolveWebhookUrl defaults to localhost", () => {
  const original = Deno.env.get("CM_WEBHOOK_URL");
  Deno.env.delete("CM_WEBHOOK_URL");
  try {
    const url = resolveWebhookUrl([], 5000);
    if (url !== "http://localhost:5000/github/webhook") {
      throw new Error(`unexpected default webhook URL: ${url}`);
    }
  } finally {
    if (original === undefined) Deno.env.delete("CM_WEBHOOK_URL");
    else Deno.env.set("CM_WEBHOOK_URL", original);
  }
});
