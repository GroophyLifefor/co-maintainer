import { test } from "node:test";
import {
  addResponseCost,
  costColumns,
  costReasonText,
  costUsage,
  emptyTally,
  settle,
} from "./cost.ts";

function tallyOf(...costs: (number | undefined)[]) {
  const tally = emptyTally();
  for (const cost of costs) addResponseCost(tally, { cost });
  return tally;
}

test("every call reporting a cost is known, and a real zero stays known", () => {
  const known = settle(tallyOf(0.01, 0.02));
  if (known.status !== "known" || Math.abs(known.usd - 0.03) > 1e-9) {
    throw new Error(JSON.stringify(known));
  }
  const zero = settle(tallyOf(0));
  if (zero.status !== "known" || zero.usd !== 0) {
    throw new Error(JSON.stringify(zero));
  }
});

test("no call reporting a cost is unknown, some reporting is partial", () => {
  const none = settle(tallyOf(undefined, undefined));
  if (none.status !== "unknown" || none.reason !== "provider_did_not_report") {
    throw new Error(JSON.stringify(none));
  }
  const some = settle(tallyOf(0.01, undefined));
  if (some.status !== "unknown" || some.reason !== "partial") {
    throw new Error(JSON.stringify(some));
  }
});

test("a run with no call at all was not recorded", () => {
  const outcome = settle(emptyTally());
  if (outcome.status !== "unknown" || outcome.reason !== "not_recorded") {
    throw new Error(JSON.stringify(outcome));
  }
});

test("a merged response counts every call it stands for", () => {
  const tally = emptyTally();
  addResponseCost(tally, { costCalls: { known: 2, unknown: 1 } });
  const outcome = settle(tally);
  if (outcome.status !== "unknown" || outcome.reason !== "partial") {
    throw new Error(JSON.stringify(outcome));
  }
});

test("a partial cost is not written to the cost column", () => {
  const columns = costColumns(settle(tallyOf(0.01, undefined)));
  if (columns.cost !== undefined || columns.cost_status !== "unknown") {
    throw new Error(JSON.stringify(columns));
  }
  if (columns.cost_note !== "partial")
    throw new Error(String(columns.cost_note));
  const known = costColumns(settle(tallyOf(0.5)));
  if (known.cost !== 0.5 || known.cost_note !== null) {
    throw new Error(JSON.stringify(known));
  }
});

test("reason texts name the provider when there is one", () => {
  if (
    costReasonText("provider_did_not_report", "OpenAI") !==
    "OpenAI did not report the cost for this review."
  ) {
    throw new Error(costReasonText("provider_did_not_report", "OpenAI"));
  }
  if (
    !/^Recorded before 0\.5\.1/.test(costReasonText("recorded_before_0_5_1"))
  ) {
    throw new Error("wrong text");
  }
});

test("the JSON usage keeps costUsd null when unknown and says why", () => {
  const known = costUsage(tallyOf(0.004));
  if (
    known.costUsd !== 0.004 ||
    known.costStatus !== "known" ||
    known.costNote !== null ||
    known.billedTo !== "server"
  ) {
    throw new Error(JSON.stringify(known));
  }
  const unknown = costUsage(tallyOf(undefined));
  if (
    unknown.costUsd !== null ||
    unknown.costStatus !== "unknown" ||
    unknown.costNote !== "provider_did_not_report"
  ) {
    throw new Error(JSON.stringify(unknown));
  }
});
