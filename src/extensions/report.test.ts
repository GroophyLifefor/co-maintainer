/** Tracking across rounds and the cost of extensions. */
import { test } from "node:test";
import {
  buildReport,
  exitCodeWithExtensions,
  extensionsCostUsd,
  nextPrevious,
} from "./report.ts";
import { addExtensionCost } from "./cost.ts";
import { emptyTally, settle } from "../util/cost.ts";
import type { ExtensionResult } from "./runner.ts";
import type { ExtensionFindingInput } from "./schema.ts";

function ok(
  name: string,
  findings: ExtensionFindingInput[],
  extra: Partial<ExtensionResult> = {},
): ExtensionResult {
  return {
    name,
    status: "ok",
    verdict: "comment",
    reason: null,
    markdown: "",
    findings,
    data: { media: [], metrics: [] },
    extraData: null,
    usage: null,
    details: null,
    durationMs: 0,
    attempts: 1,
    ...extra,
  };
}

const finding = (key?: string): ExtensionFindingInput => ({
  ...(key ? { key } : {}),
  severity: "P2",
  blocking: false,
  title: key ?? "untracked",
  body: "b",
});

test("a key seen again stays open with its id, a missing key closes", () => {
  const first = buildReport([
    ok("a", [finding("k1"), finding("k2"), finding()]),
  ]);
  const previous = nextPrevious(first);
  if (previous.length !== 2) throw new Error("an untracked finding was kept");
  const second = buildReport([ok("a", [finding("k1"), finding()])], previous);
  const byTitle = new Map(second.findings.map((row) => [row.title, row]));
  if (byTitle.get("k1")?.state !== "open") throw new Error("k1 not open");
  if (byTitle.get("k1")?.id !== first.findings[0]!.id)
    throw new Error("id changed");
  if (byTitle.get("k2")?.state !== "closed") throw new Error("k2 not closed");
  if (byTitle.get("untracked")?.state !== "new") throw new Error("untracked");
  if (byTitle.get("untracked")?.id === first.findings[2]!.id) {
    throw new Error("an untracked finding kept its id");
  }
  if (nextPrevious(second, previous).some((row) => row.key === "k2")) {
    throw new Error("a closed finding is compared again");
  }
});

test("an extension that did not return ok closes nothing and keeps its earlier set", () => {
  const previous = nextPrevious(buildReport([ok("a", [finding("k1")])]));
  const failed = buildReport(
    [ok("a", [], { status: "failed", verdict: null, reason: "boom" })],
    previous,
  );
  if (failed.findings.length !== 0)
    throw new Error("a failure closed findings");
  const kept = nextPrevious(failed, previous);
  if (kept.length !== 1 || kept[0]!.key !== "k1") throw new Error("set lost");
  const later = buildReport([ok("a", [])], kept);
  if (later.findings[0]?.state !== "closed")
    throw new Error("not closed later");
});

test("findings of one extension never close another's", () => {
  const previous = nextPrevious(buildReport([ok("a", [finding("k1")])]));
  const report = buildReport([ok("b", [finding("k1")])], previous);
  if (report.findings.length !== 1 || report.findings[0]!.state !== "new") {
    throw new Error(JSON.stringify(report.findings));
  }
});

test("request_changes blocks the exit code, a failure never does", () => {
  const asks = buildReport([ok("a", [], { verdict: "request_changes" })]);
  if (exitCodeWithExtensions(0, asks) !== 1) throw new Error("not blocking");
  const broke = buildReport([
    ok("a", [], { status: "failed", verdict: null, reason: "x" }),
  ]);
  if (exitCodeWithExtensions(0, broke) !== 0)
    throw new Error("a failure blocked");
  if (exitCodeWithExtensions(3, asks) !== 3)
    throw new Error("an error code was hidden");
});

test("the total cost includes the extensions, an unknown AI cost stays unknown", () => {
  const report = buildReport([
    ok("a", [], { usage: { costUsd: 0.25 } }),
    ok("b", []),
  ]);
  if (extensionsCostUsd(report) !== 0.25) throw new Error("sum");
  const known = emptyTally();
  known.knownCalls = 1;
  known.cost = 0.1;
  addExtensionCost(known, report);
  const outcome = settle(known);
  if (outcome.status !== "known" || Math.abs(outcome.usd - 0.35) > 1e-9) {
    throw new Error(JSON.stringify(outcome));
  }
  const unknown = emptyTally();
  unknown.unknownCalls = 1;
  addExtensionCost(unknown, report);
  if (settle(unknown).status !== "unknown") throw new Error("became known");
});
