import {
  missingAppPermissions,
  testAppAccess,
  testGithubAccess,
} from "./credentials.ts";
import { TEST_PKCS1_PEM } from "../testing/fixtures/rsa_key.ts";

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function withFetch(
  handler: (url: string) => Response,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch =
    (async (input: string | URL | Request) =>
      handler(String(input))) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("missingAppPermissions requires pull_requests write", () => {
  const missing = missingAppPermissions({
    metadata: "read",
    contents: "read",
    issues: "read",
    pull_requests: "read",
    checks: "write",
  });
  if (!missing.includes("pull_requests write")) {
    throw new Error(`expected pull_requests write, got ${missing.join(" ")}`);
  }
});

Deno.test("a PAT with repo scope is accepted", async () => {
  await withFetch((url) => {
    if (url.endsWith("/user")) {
      return jsonResponse({ login: "octo" }, 200, { "x-oauth-scopes": "repo" });
    }
    throw new Error(`unexpected ${url}`);
  }, async () => {
    const result = await testGithubAccess({
      auth: "pat",
      githubPat: "ghp_abcdefghijklmnopqrstuvwx",
    });
    if (!result.ok || result.login !== "octo") {
      throw new Error(JSON.stringify(result));
    }
  });
});

Deno.test("a PAT missing repo scope is rejected", async () => {
  await withFetch((url) => {
    if (url.endsWith("/user")) {
      return jsonResponse({ login: "octo" }, 200, {
        "x-oauth-scopes": "read:user",
      });
    }
    throw new Error(`unexpected ${url}`);
  }, async () => {
    const result = await testGithubAccess({
      auth: "pat",
      githubPat: "ghp_abcdefghijklmnopqrstuvwx",
    });
    if (result.ok || !result.message.includes("repo scope")) {
      throw new Error(JSON.stringify(result));
    }
  });
});

Deno.test("a rejected PAT is 401", async () => {
  await withFetch(
    () => jsonResponse({ message: "Bad credentials" }, 401),
    async () => {
      const result = await testGithubAccess({
        auth: "pat",
        githubPat: "ghp_nope",
      });
      if (result.ok || !result.message.includes("rejected")) {
        throw new Error(JSON.stringify(result));
      }
    },
  );
});

Deno.test("an App missing contents read is rejected", async () => {
  await withFetch((url) => {
    if (url.includes("/app/installations") && url.includes("page=1")) {
      return jsonResponse([{
        id: 1,
        account: { login: "acme", type: "Organization" },
        suspended_at: null,
        permissions: {
          metadata: "read",
          issues: "read",
          pull_requests: "write",
          checks: "write",
        },
      }]);
    }
    if (url.includes("/app/installations")) return jsonResponse([]);
    throw new Error(`unexpected ${url}`);
  }, async () => {
    const result = await testAppAccess({
      appId: "4900449",
      privateKeyPem: TEST_PKCS1_PEM,
    });
    if (result.ok || !result.message.includes("contents read")) {
      throw new Error(JSON.stringify(result));
    }
  });
});

Deno.test("an App with the required permissions is accepted", async () => {
  await withFetch((url) => {
    if (url.includes("/app/installations") && url.includes("page=1")) {
      return jsonResponse([{
        id: 1,
        account: { login: "acme", type: "Organization" },
        suspended_at: null,
        permissions: {
          metadata: "read",
          contents: "read",
          issues: "write",
          pull_requests: "write",
          checks: "write",
        },
      }]);
    }
    if (url.includes("/app/installations")) return jsonResponse([]);
    throw new Error(`unexpected ${url}`);
  }, async () => {
    const result = await testAppAccess({
      appId: "4900449",
      privateKeyPem: TEST_PKCS1_PEM,
    });
    if (!result.ok || result.installations !== 1) {
      throw new Error(JSON.stringify(result));
    }
  });
});
