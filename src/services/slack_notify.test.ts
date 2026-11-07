import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { postSlack, slackMessage } from "./slack_notify.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("slackMessage links the pull request and counts findings", () => {
  const message = slackMessage({
    repo: "acme/widgets",
    prNumber: 42,
    findings: 3,
    durationMs: 61_400,
  });
  assert.equal(
    message.text,
    "co-maintainer reviewed <https://github.com/acme/widgets/pull/42|acme/widgets#42>: 3 finding(s) in 61s.",
  );
});

test("slackMessage says when a review found nothing", () => {
  const message = slackMessage({
    repo: "acme/widgets",
    prNumber: 7,
    findings: 0,
    durationMs: 200,
  });
  assert.match(message.text, /no actionable findings in 1s\.$/);
});

test("postSlack sends the payload as JSON", async () => {
  let sent: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    sent = { url: String(url), init };
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  const ok = await postSlack("https://hooks.slack.test/T0/B0/x", {
    text: "hello",
  });
  assert.equal(ok, true);
  assert.equal(sent?.url, "https://hooks.slack.test/T0/B0/x");
  assert.equal(sent?.init?.method, "POST");
  assert.equal(sent?.init?.body, JSON.stringify({ text: "hello" }));
});

test("postSlack reports a rejected or unreachable webhook as false", async () => {
  globalThis.fetch = (async () =>
    new Response("no_service", { status: 404 })) as typeof fetch;
  assert.equal(
    await postSlack("https://hooks.slack.test/T0/B0/x", { text: "hi" }),
    false,
  );
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  assert.equal(
    await postSlack("https://hooks.slack.test/T0/B0/x", { text: "hi" }),
    false,
  );
});
