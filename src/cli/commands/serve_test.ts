import { platformWarning, resolveWebhookUrl } from "./serve.ts";

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
