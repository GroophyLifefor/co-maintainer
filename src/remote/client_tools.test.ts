/** The client's heartbeat while it runs the server's tool calls (issue 79). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runWithHeartbeat } from "./client_tools.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a batch slower than the interval sends beats until it ends, and none after", async () => {
  let beats = 0;
  const result = await runWithHeartbeat(
    wait(120).then(() => "done"),
    20,
    async () => {
      beats++;
    },
  );
  assert.equal(result, "done");
  assert.ok(beats >= 3, `${beats} beats`);
  const after = beats;
  await wait(60);
  assert.equal(beats, after, "a beat ran after the batch ended");
});

test("a batch faster than the interval sends no beat", async () => {
  let beats = 0;
  await runWithHeartbeat(Promise.resolve(1), 50, async () => {
    beats++;
  });
  await wait(80);
  assert.equal(beats, 0);
});

test("one beat ends before the next starts", async () => {
  let running = 0;
  let overlap = false;
  await runWithHeartbeat(wait(150), 5, async () => {
    running++;
    if (running > 1) overlap = true;
    await wait(30);
    running--;
  });
  assert.equal(overlap, false);
});

test("a beat still on the wire is waited for before the results go back", async () => {
  let finishedBeat = false;
  await runWithHeartbeat(wait(30), 10, async () => {
    await wait(60);
    finishedBeat = true;
  });
  assert.equal(finishedBeat, true);
});

test("a beat that fails ends the wait with its error, and a failed batch with its own", async () => {
  await assert.rejects(
    runWithHeartbeat(wait(500), 10, async () => {
      throw new Error("sync refused");
    }),
    /sync refused/,
  );
  await assert.rejects(
    runWithHeartbeat(
      wait(20).then(() => {
        throw new Error("tool broke");
      }),
      5,
      async () => {},
    ),
    /tool broke/,
  );
});
