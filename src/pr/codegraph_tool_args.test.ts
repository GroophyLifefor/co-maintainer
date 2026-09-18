import {
  guardToolArgs,
  rejectEscapingPath,
  rejectFlagLike,
  rejectUnknownKeys,
} from "./codegraph_tool_args.ts";
import { test } from "node:test";

test("codegraph_tool_args: rejects flag-like strings", () => {
  const err = rejectFlagLike("-rf", "search");
  if (!err?.includes("Tool error")) throw new Error(String(err));
});

test("codegraph_tool_args: rejects unknown keys", () => {
  const err = rejectUnknownKeys(
    { search: "x", evil: true },
    new Set(["search"]),
  );
  if (!err?.includes("unknown key")) throw new Error(String(err));
});

test("codegraph_tool_args: rejects escaping paths", () => {
  for (const file of [
    "../etc/passwd",
    "C:/Windows/System32",
    "C:\\Windows\\System32",
  ]) {
    const err = rejectEscapingPath(file);
    if (!err?.includes("inside the repository")) {
      throw new Error(`${file}: ${String(err)}`);
    }
  }
  if (rejectEscapingPath("src/foo.ts")) {
    throw new Error("repo-relative path should be allowed");
  }
});

test("codegraph_tool_args: guardToolArgs passes known keys", () => {
  const err = guardToolArgs({ search: "main" }, new Set(["search", "kind"]));
  if (err) throw new Error(err);
});
