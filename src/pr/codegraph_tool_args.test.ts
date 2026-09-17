import {
  guardToolArgs,
  rejectEscapingPath,
  rejectFlagLike,
  rejectUnknownKeys,
} from "./codegraph_tool_args.ts";

Deno.test("codegraph_tool_args: rejects flag-like strings", () => {
  const err = rejectFlagLike("-rf", "search");
  if (!err?.includes("Tool error")) throw new Error(String(err));
});

Deno.test("codegraph_tool_args: rejects unknown keys", () => {
  const err = rejectUnknownKeys({ search: "x", evil: true }, new Set(["search"]));
  if (!err?.includes("unknown key")) throw new Error(String(err));
});

Deno.test("codegraph_tool_args: rejects escaping paths", () => {
  const err = rejectEscapingPath("../etc/passwd");
  if (!err?.includes("inside the repository")) throw new Error(String(err));
});

Deno.test("codegraph_tool_args: guardToolArgs passes known keys", () => {
  const err = guardToolArgs({ search: "main" }, new Set(["search", "kind"]));
  if (err) throw new Error(err);
});
