import {
  APP_MANIFEST_EVENTS,
  APP_MANIFEST_PERMISSIONS,
  appNameProblem,
  beginManifestState,
  buildAppManifest,
  consumeManifestState,
  convertManifest,
  defaultAppName,
  manifestBlockedReason,
} from "./app_manifest.ts";
import { test } from "node:test";

test("the manifest asks for exactly the permissions the code uses", () => {
  const manifest = buildAppManifest({
    name: "co-maintainer",
    baseUrl: "https://cm.example.com",
    webhookUrl: "https://cm.example.com/github/webhook",
  });
  // Snapshot: a new GitHub call means a new permission here, not a guess.
  if (
    JSON.stringify(manifest.default_permissions) !==
    JSON.stringify({
      contents: "read",
      issues: "write",
      pull_requests: "write",
      checks: "write",
      metadata: "read",
    })
  ) {
    throw new Error(
      `permissions changed: ${JSON.stringify(manifest.default_permissions)}`,
    );
  }
  if (
    JSON.stringify(APP_MANIFEST_PERMISSIONS) !==
    JSON.stringify(manifest.default_permissions)
  ) {
    throw new Error("the exported permissions drifted from the built manifest");
  }
});

test("the manifest subscribes to the events the webhook handler dispatches", () => {
  const events = [...APP_MANIFEST_EVENTS];
  for (const wanted of [
    "pull_request",
    "pull_request_review",
    "pull_request_review_comment",
    "issue_comment",
  ]) {
    if (!events.includes(wanted as (typeof events)[number])) {
      throw new Error(`missing event: ${wanted}`);
    }
  }
  // GitHub delivers these without a subscription, so they must not be listed.
  if (events.includes("installation" as (typeof events)[number])) {
    throw new Error("installation must not be a subscribed event");
  }
  if (events.includes("installation_repositories" as (typeof events)[number])) {
    throw new Error("installation_repositories must not be subscribed");
  }
});

test("the manifest wires the callback, install base, and hook URL", () => {
  const manifest = buildAppManifest({
    name: "cm",
    baseUrl: "https://cm.example.com/",
    webhookUrl: "https://cm.example.com/hook",
  });
  if (manifest.url !== "https://cm.example.com") {
    throw new Error(`unexpected url: ${manifest.url}`);
  }
  if (
    manifest.redirect_url !==
    "https://cm.example.com/github/app-manifest/callback"
  ) {
    throw new Error(`unexpected redirect_url: ${manifest.redirect_url}`);
  }
  if (
    JSON.stringify(manifest.callback_urls) !==
    JSON.stringify(["https://cm.example.com/auth/github/callback"])
  ) {
    throw new Error(`unexpected callback_urls: ${manifest.callback_urls}`);
  }
  if (manifest.hook_attributes.url !== "https://cm.example.com/hook") {
    throw new Error("the hook URL was not used");
  }
  if (manifest.public !== false) {
    throw new Error("the App must not be public");
  }
});

test("defaultAppName derives from the host and respects the 34 char cap", () => {
  if (defaultAppName("cm.example.com") !== "co-maintainer-cm-example-com") {
    throw new Error(`unexpected name: ${defaultAppName("cm.example.com")}`);
  }
  const long = defaultAppName(
    "a-very-long-subdomain-that-will-not-fit.example.com",
  );
  if (long.length > 34) {
    throw new Error(`name too long: ${long.length}`);
  }
  if (!long.startsWith("co-maintainer-")) {
    throw new Error(`lost the prefix: ${long}`);
  }
});

test("appNameProblem rejects empty, too long, and illegal names", () => {
  if (appNameProblem("co-maintainer") !== undefined) {
    throw new Error("a plain name was rejected");
  }
  if (appNameProblem("co maintainer") === undefined) {
    throw new Error("a space was accepted");
  }
  if (appNameProblem("-leading") === undefined) {
    throw new Error("a leading hyphen was accepted");
  }
  if (appNameProblem("a".repeat(35)) === undefined) {
    throw new Error("an over-long name was accepted");
  }
  if (appNameProblem("   ") === undefined) {
    throw new Error("blank was accepted");
  }
});

test("manifestBlockedReason names the webhook problem, or stays quiet", () => {
  if (manifestBlockedReason("https://cm.example.com/hook") !== undefined) {
    throw new Error("a public URL was blocked");
  }
  const local = manifestBlockedReason("http://localhost:5000/github/webhook");
  if (!local || !local.toLowerCase().includes("localhost")) {
    throw new Error(`localhost was not explained: ${local}`);
  }
  const empty = manifestBlockedReason("");
  if (!empty) throw new Error("an empty URL was not blocked");
});

test("a manifest state is single use and expires after ten minutes", () => {
  const state = beginManifestState(0);
  if (!consumeManifestState(state, 1)) {
    throw new Error("a fresh state was rejected");
  }
  if (consumeManifestState(state, 2)) {
    throw new Error("a state was accepted twice");
  }
  const expiring = beginManifestState(0);
  if (consumeManifestState(expiring, 10 * 60 * 1000 + 1)) {
    throw new Error("an expired state was accepted");
  }
  if (consumeManifestState("never-issued", 0)) {
    throw new Error("an unknown state was accepted");
  }
});

test("convertManifest reads the credentials GitHub returns", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (!url.endsWith("/app-manifests/abc123/conversions")) {
      throw new Error(`unexpected request: ${url}`);
    }
    return Response.json({
      id: 4900449,
      slug: "co-maintainer-cm",
      pem: "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\n",
      webhook_secret: "whsec_x",
      client_id: "Iv1.abc",
      client_secret: "secret_x",
    });
  }) as typeof fetch;
  try {
    const result = await convertManifest("abc123");
    if (result.appId !== "4900449") throw new Error("app id not read");
    if (result.slug !== "co-maintainer-cm") throw new Error("slug not read");
    if (!result.pem.includes("BEGIN RSA PRIVATE KEY")) {
      throw new Error("pem not read");
    }
    if (result.webhookSecret !== "whsec_x") throw new Error("secret not read");
    if (result.clientId !== "Iv1.abc") throw new Error("client id not read");
    if (result.clientSecret !== "secret_x") {
      throw new Error("client secret not read");
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("convertManifest refuses an incomplete response", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ id: 4900449 })) as typeof fetch;
  try {
    let threw = false;
    try {
      await convertManifest("abc123");
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("an incomplete conversion was accepted");
  } finally {
    globalThis.fetch = original;
  }
});
