import { log, timed, withLogSink } from "./log.ts";

Deno.test("withLogSink captures log() calls made inside it, not outside", async () => {
  const captured: string[] = [];
  log("outside", "should not be captured");
  await withLogSink(
    (phase, message) => captured.push(`${phase}: ${message}`),
    async () => {
      log("inside", "hello");
      await timed("a step", true, async () => {});
    },
  );
  log("outside", "should not be captured either");
  if (captured.length !== 2) {
    throw new Error(
      `expected 2 captured lines, got ${JSON.stringify(captured)}`,
    );
  }
  if (captured[0] !== "inside: hello") {
    throw new Error(`unexpected first line: ${captured[0]}`);
  }
  if (!captured[1].startsWith("time: a step")) {
    throw new Error(`timed() did not route through the sink: ${captured[1]}`);
  }
});

Deno.test("withLogSink scopes to its own async call, concurrent sinks do not cross-talk", async () => {
  const a: string[] = [];
  const b: string[] = [];
  await Promise.all([
    withLogSink((_phase, message) => a.push(message), async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      log("x", "from a");
    }),
    withLogSink((_phase, message) => b.push(message), async () => {
      log("x", "from b");
    }),
  ]);
  if (!a.includes("from a") || a.includes("from b")) {
    throw new Error(`sink a leaked: ${JSON.stringify(a)}`);
  }
  if (!b.includes("from b") || b.includes("from a")) {
    throw new Error(`sink b leaked: ${JSON.stringify(b)}`);
  }
});
