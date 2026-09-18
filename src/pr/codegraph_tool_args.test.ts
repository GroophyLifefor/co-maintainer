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

test("codegraph_tool_args: rejects shell metacharacters in values", () => {
  for (const value of [
    "a & calc.exe",
    "a | del /f /q x",
    "a > out.txt",
    "a ^ b",
    "a %PATH% b",
    "a\nb",
  ]) {
    const err = guardToolArgs({ search: value }, new Set(["search"]));
    if (!err?.includes("metacharacter")) {
      throw new Error(`${value}: ${String(err)}`);
    }
  }
  // A plain regex-ish search term still gets through.
  if (guardToolArgs({ search: "main.*index" }, new Set(["search"]))) {
    throw new Error("a normal search term should be allowed");
  }
});

test("codegraph_tool_args: rejects shell metacharacters in paths", () => {
  // Paths reach `cmd /c` on Windows just like other values, so a metacharacter
  // in a file name must be refused rather than reaching the shell.
  for (const value of ["src/a&b.ts", "src/a|b.ts", "src/a> b.ts"]) {
    if (!rejectEscapingPath(value)) {
      throw new Error(`${value} was allowed`);
    }
  }
  if (rejectEscapingPath("src/a.ts")) {
    throw new Error("a plain path should be allowed");
  }
});
