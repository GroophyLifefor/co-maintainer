import {
  ensureDashboardPassword,
  platformWarning,
  resolveAuthMethods,
  resolveWebhookUrl,
} from "./serve.ts";
import { memoryPasswordStore } from "../../server/auth.ts";
import { deleteEnv, getEnv, setEnv } from "../../testing/runtime.ts";
import { test } from "node:test";

test("resolveAuthMethods defaults to password only", () => {
  const auth = resolveAuthMethods([], {});
  if (!auth.password || auth.github) {
    throw new Error(`expected password-only, got ${JSON.stringify(auth)}`);
  }
});

test("resolveAuthMethods: config enables github, no flags needed", () => {
  const auth = resolveAuthMethods([], { githubAuthEnabled: true });
  if (!auth.password || !auth.github) {
    throw new Error(`expected both on, got ${JSON.stringify(auth)}`);
  }
});

test("resolveAuthMethods: a CLI flag always overrides its config default", () => {
  const auth = resolveAuthMethods(
    ["--disable-auth=password", "--enable-auth=github"],
    {
      githubAuthEnabled: false,
    },
  );
  if (auth.password || !auth.github) {
    throw new Error(`expected github-only, got ${JSON.stringify(auth)}`);
  }
});

test("resolveAuthMethods dies when both methods end up off", () => {
  let threw = false;
  try {
    resolveAuthMethods(["--disable-auth=password"], {});
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected resolveAuthMethods to die");
});

test("resolveAuthMethods rejects an unknown --disable-auth value", () => {
  let threw = false;
  try {
    resolveAuthMethods(["--disable-auth=github"], {});
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected resolveAuthMethods to die");
});

test("platformWarning is silent on linux and speaks up everywhere else", () => {
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

test("resolveWebhookUrl prefers the CLI URL and accepts public http(s)", () => {
  const url = resolveWebhookUrl(
    ["--webhook-url=https://example.com/github/webhook"],
    5000,
  );
  if (url !== "https://example.com/github/webhook") {
    throw new Error(`unexpected webhook URL: ${url}`);
  }
});

test("resolveWebhookUrl rejects malformed absolute URLs", () => {
  // `new URL` accepts these; a leaked scheme or a bare path would make
  // GitHub deliver webhooks to a host that does not exist.
  for (const bad of [
    "http://http://178.105.8.95/:5000/github/webhook",
    "http:///github/webhook",
    "http:////evil/github/webhook",
    "https://example.com/",
    "ftp://example.com/github/webhook",
    "not a url",
  ]) {
    let threw = false;
    try {
      resolveWebhookUrl([`--webhook-url=${bad}`], 5000);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`accepted malformed webhook URL: ${bad}`);
  }
});

test("resolveWebhookUrl accepts internal hosts and IPv6 literals", () => {
  // A webhook can legitimately point at a Docker/k8s service name (no dot, no
  // port) or an IPv6 literal. The empty-authority spelling `http:///x` parses
  // to the same host, so it is rejected on the raw string instead.
  for (const good of [
    "http://gitserver/github/webhook",
    "http://codegraph:8080/github/webhook",
    "http://[::1]/github/webhook",
    "http://[2001:db8::1]:5000/github/webhook",
  ]) {
    const url = resolveWebhookUrl([`--webhook-url=${good}`], 5000);
    if (url !== good) throw new Error(`${good} became ${url}`);
  }
});

test("resolveWebhookUrl defaults to localhost", () => {
  const original = getEnv("CM_WEBHOOK_URL");
  deleteEnv("CM_WEBHOOK_URL");
  try {
    const url = resolveWebhookUrl([], 5000);
    if (url !== "http://localhost:5000/github/webhook") {
      throw new Error(`unexpected default webhook URL: ${url}`);
    }
  } finally {
    if (original === undefined) deleteEnv("CM_WEBHOOK_URL");
    else setEnv("CM_WEBHOOK_URL", original);
  }
});

test("ensureDashboardPassword generates one on a first start and keeps it after", async () => {
  const store = memoryPasswordStore("");
  const generated = await ensureDashboardPassword([], false, store);
  if (!generated || !(await store.verify(generated))) {
    throw new Error("the generated password was not stored");
  }
  const again = await ensureDashboardPassword([], true, store);
  if (again !== undefined || !(await store.verify(generated))) {
    throw new Error("a restart replaced the stored password");
  }
});

test("ensureDashboardPassword lets --password replace the stored one", async () => {
  const store = memoryPasswordStore("old-password");
  const generated = await ensureDashboardPassword(
    ["--password=new-password"],
    true,
    store,
  );
  if (generated !== undefined) throw new Error("printed a generated password");
  if (!(await store.verify("new-password"))) {
    throw new Error("the flag did not replace the password");
  }
  if (await store.verify("old-password")) {
    throw new Error("the old password still works");
  }
});
