/** How the fake AI picks a rule and what it answers. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeAi, finding } from "./fake_ai.ts";

type Json = Record<string, any>;

const body = (prompt: string, extra: Json = {}) => ({
  model: "m",
  messages: [{ role: "user", content: prompt }],
  ...extra,
});

const text = (answer: { body: unknown }) =>
  (answer.body as Json).choices[0].message.content as string;

test("a rule matches by job, by prompt, or both, and the first match wins", () => {
  const ai = new FakeAi();
  ai.use(
    { name: "both", job: "a", prompt: "special", reply: "both" },
    { name: "job", job: "a", reply: "job" },
    { name: "prompt", prompt: /^hello/, reply: "prompt" },
  );
  assert.equal(text(ai.answer(body("a special call"), "a")), "both");
  assert.equal(text(ai.answer(body("plain"), "a")), "job");
  assert.equal(text(ai.answer(body("hello there"), "b")), "prompt");
  assert.equal(ai.answer(body("plain"), "ab").rule, undefined, "job is exact");
});

test("a list answers one call each, then the rule stops matching", () => {
  const ai = new FakeAi();
  ai.use({ job: "a", reply: ["one", "two"] }, { job: "a", reply: "after" });
  const answers = [1, 2, 3].map(() => text(ai.answer(body("x"), "a")));
  assert.deepEqual(answers, ["one", "two", "after"]);
});

test("a rule added later wins, and an optional rule is never unused", () => {
  const ai = new FakeAi();
  ai.use({ name: "script", job: "a", reply: "A" });
  ai.use({ name: "later", job: "a", reply: "B" });
  ai.use({ name: "maybe", job: "never", reply: "x", optional: true });
  assert.equal(text(ai.answer(body("x"), "a")), "B");
  assert.deepEqual(
    ai.unused().map((rule) => rule.name),
    ["script"],
  );
});

test("times limits a rule, and a function sees the round", () => {
  const ai = new FakeAi();
  ai.use(
    { job: "a", times: 1, reply: "once" },
    { job: "a", reply: ({ round }) => `round ${round}` },
  );
  assert.equal(text(ai.answer(body("x"), "a")), "once");
  const withTool = {
    model: "m",
    messages: [
      { role: "user", content: "x" },
      { role: "assistant", content: null, tool_calls: [] },
      { role: "tool", tool_call_id: "1", content: "result" },
    ],
  };
  assert.equal(text(ai.answer(withTool, "a")), "round 1");
});

test("no rule means an error answer and no rule name", () => {
  const ai = new FakeAi();
  const answer = ai.answer(body("x"), "lonely");
  assert.equal(answer.status, 500);
  assert.equal(answer.rule, undefined);
  assert.match(
    JSON.stringify(answer.body),
    /no fake AI rule answers job lonely/,
  );
});

test("findings, tool calls, a cut-off, an output limit and an error", () => {
  const ai = new FakeAi();
  const found = finding({ path: "a.ts", line: 3, title: "Bad" });
  ai.use(
    { job: "findings", reply: { findings: [found] } },
    {
      job: "tools",
      reply: { toolCalls: [{ name: "t", arguments: { x: 1 } }] },
    },
    { job: "cut", reply: { cutOff: "par" } },
    { job: "limit", reply: { outputLimit: "" } },
    { job: "error", reply: { error: 429, message: "slow down" } },
  );
  assert.deepEqual(JSON.parse(text(ai.answer(body("x"), "findings"))), {
    findings: [found],
  });
  const tools = ai.answer(body("x"), "tools").body as Json;
  assert.equal(tools.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(tools.choices[0].message.tool_calls[0].function, {
    name: "t",
    arguments: '{"x":1}',
  });
  assert.equal(ai.answer(body("x"), "cut").cutOff, "par");
  const limit = ai.answer(body("x"), "limit").body as Json;
  assert.equal(limit.choices[0].finish_reason, "length");
  const error = ai.answer(body("x"), "error");
  assert.equal(error.status, 429);
  assert.match(JSON.stringify(error.body), /slow down/);
  assert.deepEqual(ai.unused(), []);
});
