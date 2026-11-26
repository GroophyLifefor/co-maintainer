import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_QUEUE_MAX_AGE_MINUTES,
  isQueuedTooLong,
  MIN_QUEUE_MAX_AGE_MINUTES,
  queueMaxAgeMs,
  waitedTooLong,
} from "./queue_age.ts";

const MINUTE = 60_000;

test("the queue age limit is 1440 minutes unless set, and never under 60", () => {
  assert.equal(queueMaxAgeMs({}), DEFAULT_QUEUE_MAX_AGE_MINUTES * MINUTE);
  assert.equal(DEFAULT_QUEUE_MAX_AGE_MINUTES, 1440);
  assert.equal(queueMaxAgeMs({ queueMaxAgeMinutes: 90 }), 90 * MINUTE);
  assert.equal(
    queueMaxAgeMs({ queueMaxAgeMinutes: 5 }),
    MIN_QUEUE_MAX_AGE_MINUTES * MINUTE,
  );
  for (const value of [0, -3, Number.NaN, undefined]) {
    assert.equal(
      queueMaxAgeMs({ queueMaxAgeMinutes: value }),
      DEFAULT_QUEUE_MAX_AGE_MINUTES * MINUTE,
    );
  }
});

test("a job waited too long only past the limit", () => {
  const now = Date.parse("2030-01-02T00:00:00Z");
  const limit = 90 * MINUTE;
  const at = (minutesAgo: number) => ({
    created_at: new Date(now - minutesAgo * MINUTE).toISOString(),
  });
  assert.equal(waitedTooLong(at(89), now, limit), false);
  assert.equal(waitedTooLong(at(91), now, limit), true);
  assert.equal(waitedTooLong({ created_at: "garbage" }, now, limit), false);
});

test("both skip reasons read as queued too long, others do not", () => {
  assert.equal(isQueuedTooLong("queued_too_long"), true);
  assert.equal(isQueuedTooLong("queued_too_long_no_note"), true);
  assert.equal(isQueuedTooLong("superseded"), false);
  assert.equal(isQueuedTooLong(null), false);
});

test("a claimed job is still skipped: its start does not count against the limit", () => {
  // The worker sets started_at when it claims the job, before the handler
  // asks. A rule that spared started jobs would never skip any.
  const now = Date.parse("2030-01-02T00:00:00Z");
  const claimed = {
    created_at: new Date(now - 3 * 60 * MINUTE).toISOString(),
    started_at: new Date(now - 1000).toISOString(),
  };
  assert.equal(waitedTooLong(claimed, now, 90 * MINUTE), true);
});
