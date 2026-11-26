import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContentSchedule,
  contentPerHour,
  isContentWrite,
} from "./content_bucket.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

test("the first 80 writes in a minute go at once, the 81st waits for the first to leave the window", () => {
  const schedule = new ContentSchedule();
  const now = 1_000_000;
  const times = Array.from({ length: 81 }, () =>
    schedule.reserve(now, 80, 450),
  );
  assert.ok(times.slice(0, 80).every((t) => t === now));
  assert.equal(times[80], now + MINUTE);
});

test("the hourly allowance spreads writes out, never more than it in any hour", () => {
  const schedule = new ContentSchedule();
  const now = 0;
  const times = Array.from({ length: 1000 }, () =>
    schedule.reserve(now, 80, 450),
  );
  for (const start of times) {
    const inWindow = times.filter((t) => t >= start && t < start + HOUR);
    assert.ok(inWindow.length <= 450, `${inWindow.length} in an hour`);
  }
  // And never more than 80 in any minute.
  for (const start of times) {
    const inMinute = times.filter((t) => t >= start && t < start + MINUTE);
    assert.ok(inMinute.length <= 80, `${inMinute.length} in a minute`);
  }
});

test("a quiet schedule makes a write wait for nothing", () => {
  const schedule = new ContentSchedule();
  assert.equal(schedule.reserve(5000, 80, 450), 5000);
  assert.equal(schedule.reserve(5000 + 2 * HOUR, 80, 450), 5000 + 2 * HOUR);
});

test("the hourly allowance is 450, settable, and never over GitHub's 500", () => {
  assert.equal(contentPerHour({}), 450);
  assert.equal(contentPerHour({ contentWritesPerHour: 120 }), 120);
  assert.equal(contentPerHour({ contentWritesPerHour: 900 }), 500);
  for (const value of [0, -1, Number.NaN, undefined]) {
    assert.equal(contentPerHour({ contentWritesPerHour: value }), 450);
  }
});

test("only reviews and comments are content writes, check runs and reads are not", () => {
  assert.equal(isContentWrite("POST", "repos/o/r/pulls/3/reviews"), true);
  assert.equal(isContentWrite("POST", "repos/o/r/issues/3/comments"), true);
  assert.equal(isContentWrite("POST", "repos/o/r/pulls/3/comments"), true);
  assert.equal(isContentWrite("POST", "repos/o/r/check-runs"), false);
  assert.equal(isContentWrite("GET", "repos/o/r/pulls/3/reviews"), false);
  assert.equal(isContentWrite("POST", "repos/o/r/pulls/3/files"), false);
});
