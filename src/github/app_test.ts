import { AppClient, AppJwtClient, listInstallationsWithRepos } from "./app.ts";
import { TEST_PKCS1_PEM } from "../testing/fixtures/rsa_key.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function withFetch(
  handler: (url: string, init: RequestInit) => Response,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch =
    (async (input: string | URL | Request, init?: RequestInit) =>
      handler(String(input), init ?? {})) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function authHeader(init: RequestInit): string {
  return new Headers(init.headers).get("authorization") ?? "";
}

Deno.test("AppClient signs requests with a fresh installation token, Bearer-authorized", async () => {
  await withFetch((url, init) => {
    if (url.includes("/access_tokens")) {
      if (!authHeader(init).startsWith("Bearer ")) {
        throw new Error("token mint call missing the app JWT");
      }
      return jsonResponse({
        token: "ghs_installation_token",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    }
    if (url === "https://api.github.com/repos/acme/widgets") {
      if (authHeader(init) !== "Bearer ghs_installation_token") {
        throw new Error(
          `expected the installation token, got: ${authHeader(init)}`,
        );
      }
      return jsonResponse({ full_name: "acme/widgets" });
    }
    throw new Error(`unexpected request: ${url}`);
  }, async () => {
    const client = new AppClient("4900449", TEST_PKCS1_PEM, 123);
    const repo = await client.request<{ full_name: string }>(
      "repos/acme/widgets",
    );
    if (repo.full_name !== "acme/widgets") {
      throw new Error(`unexpected response: ${JSON.stringify(repo)}`);
    }
  });
});

Deno.test("installation tokens are cached and reused while still valid", async () => {
  let mintCalls = 0;
  await withFetch((url) => {
    if (url.includes("/access_tokens")) {
      mintCalls++;
      return jsonResponse({
        token: `ghs_${mintCalls}`,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    }
    return jsonResponse({ ok: true });
  }, async () => {
    const app = new AppJwtClient("4900449", TEST_PKCS1_PEM);
    const first = await app.installationToken(999);
    const second = await app.installationToken(999);
    if (first !== second) throw new Error("a valid token was not reused");
    if (mintCalls !== 1) {
      throw new Error(`expected exactly one mint call, got ${mintCalls}`);
    }
  });
});

Deno.test("an expired cached token is refreshed instead of reused", async () => {
  let mintCalls = 0;
  await withFetch((url) => {
    if (url.includes("/access_tokens")) {
      mintCalls++;
      // Expired the instant it is minted, forcing the next call to refresh.
      return jsonResponse({
        token: `ghs_${mintCalls}`,
        expires_at: new Date(Date.now() - 1000).toISOString(),
      });
    }
    return jsonResponse({ ok: true });
  }, async () => {
    const app = new AppJwtClient("4900449", TEST_PKCS1_PEM);
    const first = await app.installationToken(555);
    const second = await app.installationToken(555);
    if (first === second) throw new Error("an expired token was reused");
    if (mintCalls !== 2) {
      throw new Error(`expected a refresh, got ${mintCalls} mint calls`);
    }
  });
});

Deno.test("listInstallationsWithRepos merges each installation with its repos", async () => {
  await withFetch((url) => {
    if (
      url === "https://api.github.com/app/installations?per_page=100&page=1"
    ) {
      return jsonResponse([
        {
          id: 1,
          account: { login: "acme", type: "Organization" },
          suspended_at: null,
        },
      ]);
    }
    if (
      url === "https://api.github.com/app/installations?per_page=100&page=2"
    ) {
      return jsonResponse([]);
    }
    if (url.includes("/access_tokens")) {
      return jsonResponse({
        token: "ghs_x",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    }
    if (url === "https://api.github.com/installation/repositories") {
      return jsonResponse({
        repositories: [{ full_name: "acme/widgets", private: true }],
      });
    }
    throw new Error(`unexpected request: ${url}`);
  }, async () => {
    const result = await listInstallationsWithRepos("4900449", TEST_PKCS1_PEM);
    if (
      result.length !== 1 || result[0].installation.account?.login !== "acme"
    ) {
      throw new Error(`unexpected result: ${JSON.stringify(result)}`);
    }
    if (
      result[0].repos[0]?.fullName !== "acme/widgets" ||
      !result[0].repos[0].private
    ) {
      throw new Error(`unexpected repos: ${JSON.stringify(result[0].repos)}`);
    }
  });
});
