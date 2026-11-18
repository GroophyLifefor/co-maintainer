import { test } from "node:test";
import assert from "node:assert/strict";
import { withDashboard } from "../../testing/dashboard_pages.ts";
import { activateRepo } from "../../store/repos.ts";
import { clearOpenPullsCache } from "../../github/open_pulls_cache.ts";
import { TEST_PKCS1_PEM } from "../../testing/fixtures/rsa_key.ts";

const REPO = "acme/widgets";

test("a second visit to the Pull requests tab makes no GitHub call", async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (!url.startsWith("https://api.github.com/")) {
      return original(input as Parameters<typeof fetch>[0]);
    }
    calls.push(url);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.includes("/access_tokens")) {
      return json({
        token: "ghs_tab",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    }
    if (url.includes("/app/installations")) {
      return json([{ id: 9, account: { login: "acme", type: "User" } }]);
    }
    if (url.includes("/installation/repositories")) {
      return json({ repositories: [{ full_name: REPO }] });
    }
    if (url.includes(`/repos/${REPO}/pulls`)) {
      return json([
        {
          number: 12,
          title: "Tidy the helper",
          draft: false,
          user: { login: "octocat" },
          head: { ref: "fix/helper" },
          updated_at: "2026-09-22T10:00:00Z",
        },
      ]);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  clearOpenPullsCache();
  try {
    await withDashboard(
      async (get) => {
        activateRepo(REPO, 9);
        const first = await get(`/repos/${REPO}/pulls`);
        assert.ok(first.html.includes("Tidy the helper"));
        const before = calls.length;
        assert.ok(before > 0, "the first visit asked GitHub");
        const second = await get(`/repos/${REPO}/pulls`);
        assert.ok(second.html.includes("Tidy the helper"));
        assert.deepEqual(
          calls.slice(before),
          [],
          "the second visit asked GitHub",
        );
      },
      { githubAppId: "4900449", githubAppPrivateKey: TEST_PKCS1_PEM },
    );
  } finally {
    globalThis.fetch = original;
    clearOpenPullsCache();
  }
});
