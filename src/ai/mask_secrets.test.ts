import assert from "node:assert/strict";
import { test } from "node:test";
import { isolateTestFile } from "../testing/locations.ts";
import type { AiProvider, AiRequest, AiResponse } from "../types.ts";
import {
  maskSecretsOn,
  maskSecretsRequest,
  withSecretMask,
} from "./mask_secrets.ts";

isolateTestFile();

// Built at runtime, so no secret shape sits in the source.
const TOKEN = ["ghp", "_", "Q".repeat(36)].join("");
const KEY = ["sk-or-", "v1-", "r".repeat(24)].join("");

function request(): AiRequest {
  return {
    system: "Review the change.",
    prompt: `+const token = "${TOKEN}"`,
    messages: [
      { role: "user", content: `diff\n+const token = "${TOKEN}"` },
      { role: "tool", tool_call_id: "1", content: `OPENROUTER=${KEY}\nnext` },
      { role: "assistant", content: null },
    ],
    maxTokens: 100,
    job: "review_pull_request",
  };
}

test("every text of a request is masked, the caller's request is not changed", () => {
  const original = request();
  const before = JSON.stringify(original);
  const { request: masked, count } = maskSecretsRequest(original);
  const wire = JSON.stringify(masked);
  assert.ok(!wire.includes(TOKEN) && !wire.includes(KEY), wire);
  assert.ok(wire.includes("[redacted:github-token]"));
  assert.ok(wire.includes("[redacted:openrouter-key]"));
  assert.equal(count, 2, "the same token twice counts once");
  assert.equal(JSON.stringify(original), before);
  assert.equal(masked.system, "Review the change.");
  assert.equal(masked.messages?.[2]?.content, null);
});

test("the wrapped provider gets the masked request and reports the count", async () => {
  const seen: AiRequest[] = [];
  const inner: AiProvider = {
    supportsTools: true,
    async complete(sent): Promise<AiResponse> {
      seen.push(sent);
      return {
        text: "ok",
        tokensIn: 1,
        tokensOut: 1,
        cost: 0,
        model: "m",
        provider: "openrouter",
      };
    },
  };
  const response = await withSecretMask(inner).complete(request());
  assert.ok(!JSON.stringify(seen[0]).includes(TOKEN));
  assert.equal(response.secretsMasked, 2);
  const clean = await withSecretMask(inner).complete({
    prompt: "no secret here",
    maxTokens: 10,
    job: "x",
  });
  assert.equal(clean.secretsMasked, undefined);
});

test("masking is on unless the config turns it off", () => {
  assert.equal(maskSecretsOn({}), true);
  assert.equal(maskSecretsOn({ maskSecrets: true }), true);
  assert.equal(maskSecretsOn({ maskSecrets: false }), false);
});
