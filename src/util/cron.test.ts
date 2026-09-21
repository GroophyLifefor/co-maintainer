import { test } from "node:test";
import { cronMatches, nextCronRun, parseCron } from "./cron.ts";

const at = (iso: string) => new Date(iso);

test("a daily expression matches only its minute", () => {
  const cron = parseCron("30 4 * * *");
  if (!cronMatches(cron, at("2026-09-21T04:30:00Z"))) throw new Error("miss");
  if (cronMatches(cron, at("2026-09-21T04:31:00Z"))) throw new Error("late");
  if (cronMatches(cron, at("2026-09-21T05:30:00Z"))) throw new Error("hour");
});

test("lists, ranges and steps expand", () => {
  const cron = parseCron("0 */6 * 1-3,12 *");
  const hours = [...cron.hours].sort((a, b) => a - b);
  if (hours.join() !== "0,6,12,18") throw new Error(`hours ${hours}`);
  const months = [...cron.months].sort((a, b) => a - b);
  if (months.join() !== "1,2,3,12") throw new Error(`months ${months}`);
  if (parseCron("0 9-17/4 * * *").hours.size !== 3)
    throw new Error("range step");
});

test("day of week accepts 7 as Sunday", () => {
  const cron = parseCron("0 0 * * 7");
  if (!cronMatches(cron, at("2026-09-20T00:00:00Z"))) throw new Error("Sunday");
  if (cronMatches(cron, at("2026-09-21T00:00:00Z"))) throw new Error("Monday");
});

test("two restricted day fields match when either does", () => {
  const cron = parseCron("0 0 13 * 5");
  if (!cronMatches(cron, at("2026-09-13T00:00:00Z"))) throw new Error("13th");
  if (!cronMatches(cron, at("2026-09-18T00:00:00Z"))) throw new Error("Friday");
  if (cronMatches(cron, at("2026-09-14T00:00:00Z"))) throw new Error("Monday");
});

test("a star day field leaves the other one in charge", () => {
  const cron = parseCron("0 0 * * 1");
  if (!cronMatches(cron, at("2026-09-21T00:00:00Z"))) throw new Error("Monday");
  if (cronMatches(cron, at("2026-09-22T00:00:00Z"))) throw new Error("Tuesday");
});

test("invalid expressions are rejected with a reason", () => {
  for (const bad of [
    "",
    "* * * *",
    "* * * * * *",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * * 13 *",
    "* * * * 8",
    "5-1 * * * *",
    "*/0 * * * *",
    "a * * * *",
    "1,,2 * * * *",
    "1-2-3 * * * *",
    "*/2/3 * * * *",
  ]) {
    let threw = false;
    try {
      parseCron(bad);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`accepted ${JSON.stringify(bad)}`);
  }
});

test("nextCronRun finds the next matching minute after a time", () => {
  const cron = parseCron("30 4 * * *");
  const next = nextCronRun(cron, at("2026-09-21T04:30:00Z"));
  if (next?.toISOString() !== "2026-09-22T04:30:00.000Z") {
    throw new Error(`got ${next?.toISOString()}`);
  }
  const sooner = nextCronRun(cron, at("2026-09-21T03:00:10Z"));
  if (sooner?.toISOString() !== "2026-09-21T04:30:00.000Z") {
    throw new Error(`got ${sooner?.toISOString()}`);
  }
});

test("nextCronRun gives up on a date that never comes within a year", () => {
  if (nextCronRun(parseCron("0 0 31 2 *"), at("2026-01-01T00:00:00Z"))) {
    throw new Error("February 31st matched");
  }
});

test("a stepped star day field counts as unrestricted, as in classic cron", () => {
  const cron = parseCron("0 0 */2 * 1");
  if (!cron.anyDayOfMonth) throw new Error("*/2 was treated as restricted");
  if (!cronMatches(cron, at("2026-09-21T00:00:00Z"))) {
    throw new Error("Monday the 21st is an odd day and should match");
  }
  if (cronMatches(cron, at("2026-09-28T00:00:00Z"))) {
    throw new Error("Monday the 28th is an even day and should not match");
  }
  if (cronMatches(cron, at("2026-09-23T00:00:00Z"))) {
    throw new Error("an odd day that is not a Monday should not match");
  }
});
