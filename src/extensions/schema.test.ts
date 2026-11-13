/** The response schema: what passes, what fails, and the reason a failure
 * gives. */
import { test } from "node:test";
import {
  parseResponse,
  responseSchemaTable,
  RESPONSE_FIELDS,
  validateResponse,
} from "./schema.ts";

function ok(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "qa-vision",
    status: "ok",
    verdict: "comment",
    ...extra,
  };
}

function reasonOf(value: unknown): string {
  const result = validateResponse(value);
  if (result.ok) throw new Error(`accepted ${JSON.stringify(value)}`);
  return result.reason;
}

test("the example response from the issue is accepted and filled in", () => {
  const result = validateResponse({
    schemaVersion: 1,
    name: "qa-vision",
    status: "ok",
    verdict: "request_changes",
    markdown: "**QA vision (beta)**",
    findings: [
      {
        key: "secret:aws-key:src/a.ts",
        severity: "P2",
        blocking: true,
        title: "t",
        body: "b",
        path: "src/a.ts",
        lineFrom: 10,
        lineTo: 12,
      },
    ],
    data: {
      media: [{ kind: "video", label: "main", url: "https://e.test/v.mp4" }],
      metrics: [],
    },
    extraData: { cases: [] },
    usage: { costUsd: 0.42, tokensIn: 0, tokensOut: 0, cachedIn: 0 },
    unknownField: "ignored",
  });
  if (!result.ok) throw new Error(result.reason);
  const response = result.response;
  if (response.findings[0]?.key !== "secret:aws-key:src/a.ts") {
    throw new Error("the key was lost");
  }
  if (response.usage?.costUsd !== 0.42) throw new Error("usage was lost");
  if ("unknownField" in response) throw new Error("an unknown field leaked");
});

test("the optional parts default to empty", () => {
  const result = validateResponse(ok());
  if (!result.ok) throw new Error(result.reason);
  const { markdown, findings, data, usage } = result.response;
  if (markdown !== "" || findings.length !== 0) throw new Error("not empty");
  if (data.media.length !== 0 || data.metrics.length !== 0) {
    throw new Error("data not empty");
  }
  if (usage !== undefined) throw new Error("usage invented");
});

test("an unsupported schemaVersion is named as the reason", () => {
  const reason = reasonOf(ok({ schemaVersion: 2, status: 7 }));
  if (!reason.startsWith("unsupported schemaVersion 2"))
    throw new Error(reason);
});

test("the verdict is required with ok and absent otherwise", () => {
  const { verdict: _, ...noVerdict } = ok();
  if (!reasonOf(noVerdict).includes("verdict is required")) {
    throw new Error("ok without a verdict passed");
  }
  if (!reasonOf(ok({ status: "failed" })).includes("verdict must be absent")) {
    throw new Error("failed with a verdict passed");
  }
});

test("skipped and retry carry a reason, retry a wait of at most 180 seconds", () => {
  const skipped = { schemaVersion: 1, name: "x", status: "skipped" };
  if (!reasonOf(skipped).includes("reason is required")) {
    throw new Error("skipped without a reason passed");
  }
  const retry = { ...skipped, status: "retry", reason: "busy" };
  if (!reasonOf(retry).includes("retryAfterSeconds is required")) {
    throw new Error("retry without a wait passed");
  }
  if (!reasonOf({ ...retry, retryAfterSeconds: 181 }).includes("at most 180")) {
    throw new Error("a wait over 180 passed");
  }
  if (!validateResponse({ ...retry, retryAfterSeconds: 180 }).ok) {
    throw new Error("a wait of 180 failed");
  }
});

test("a finding needs severity, blocking, title and body", () => {
  for (const field of ["severity", "blocking", "title", "body"]) {
    const finding: Record<string, unknown> = {
      severity: "P1",
      blocking: false,
      title: "t",
      body: "b",
    };
    delete finding[field];
    const reason = reasonOf(ok({ findings: [finding] }));
    if (reason !== `findings[0].${field} is required`) throw new Error(reason);
  }
  const reason = reasonOf(
    ok({
      findings: [{ severity: "P5", blocking: false, title: "t", body: "b" }],
    }),
  );
  if (!reason.includes("P0, P1, P2, P3")) throw new Error(reason);
});

test("a line needs a path, and lineTo cannot come before lineFrom", () => {
  const base = { severity: "P1", blocking: false, title: "t", body: "b" };
  if (
    !reasonOf(ok({ findings: [{ ...base, lineFrom: 3 }] })).includes("path")
  ) {
    throw new Error("a line without a path passed");
  }
  const backwards = { ...base, path: "a.ts", lineFrom: 5, lineTo: 4 };
  if (!reasonOf(ok({ findings: [backwards] })).includes("before lineFrom")) {
    throw new Error("a backwards range passed");
  }
});

test("media is an http or https URL the extension uploaded", () => {
  const media = (url: string) =>
    ok({ data: { media: [{ kind: "video", label: "pr", url }] } });
  if (!reasonOf(media("file:///etc/passwd")).includes("http or https URL")) {
    throw new Error("a file URL passed");
  }
  if (!validateResponse(media("https://cdn.test/a.mp4")).ok) {
    throw new Error("an https URL failed");
  }
});

test("stdout must be exactly one JSON document", () => {
  const empty = parseResponse("  \n");
  if (empty.ok || empty.reason !== "the command printed nothing") {
    throw new Error(JSON.stringify(empty));
  }
  const noisy = parseResponse(`starting\n${JSON.stringify(ok())}`);
  if (noisy.ok) throw new Error("log lines around the JSON passed");
  if (!parseResponse(`\n${JSON.stringify(ok())}\n`).ok) {
    throw new Error("surrounding whitespace failed");
  }
});

test("the docs table lists every field the validator knows", () => {
  const table = responseSchemaTable();
  const walk = (fields: typeof RESPONSE_FIELDS, prefix: string): string[] =>
    fields.flatMap((spec) => [
      `${prefix}${spec.name}`,
      ...(spec.fields
        ? walk(
            spec.fields,
            spec.type === "array"
              ? `${prefix}${spec.name}[].`
              : `${prefix}${spec.name}.`,
          )
        : []),
    ]);
  for (const path of walk(RESPONSE_FIELDS, "")) {
    if (!table.includes(`| \`${path}\` |`)) {
      throw new Error(`the table has no row for ${path}`);
    }
  }
});
