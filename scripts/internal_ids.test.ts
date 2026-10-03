/** Code must not point at internal planning documents or task numbers.
 *
 * A reference like a task number or a bug code in a comment means nothing to a
 * contributor who was not part of the planning, and it rots when the plan
 * moves. A comment says why the code is the way it is, in words. This scans the
 * code and the workflows and fails on the shapes such a reference takes. */
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const self = relative(root, fileURLToPath(import.meta.url))
  .split(sep)
  .join("/");

const SCANNED = ["src", "scripts", ".github", "benchmark"];
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".git"]);
const EXTENSIONS = /\.(ts|mjs|js|sh|cmd|yml|yaml)$/;

/** What an internal reference looks like: a task number, a bug code, or a
 * pointer into the planning document. */
export const INTERNAL_REFERENCES: { name: string; pattern: RegExp }[] = [
  { name: "task number", pattern: /\bCORE-\d+/ },
  { name: "bug code", pattern: /\bF\d{2}[a-z]?\b/ },
  { name: "plan section", pattern: /\bplan\s*§/i },
  { name: "planning document", pattern: /\bPLAN\.md\s+Section/ },
];

/** A long line with no space is a fixture such as a certificate or an image,
 * where a code like `F04` is just part of the encoding. */
function isEncodedBlob(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 60 && !trimmed.includes(" ");
}

export function internalReferences(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    if (isEncodedBlob(line)) continue;
    for (const { name, pattern } of INTERNAL_REFERENCES) {
      if (pattern.test(line))
        found.push(`${name}: ${line.trim().slice(0, 100)}`);
    }
  }
  return found;
}

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (EXTENSIONS.test(entry)) out.push(path);
  }
  return out;
}

test("the matcher finds each kind of internal reference and leaves ordinary text alone", () => {
  const cases: [string, number][] = [
    ["// Before CORE-12 this was different", 1],
    ["/** The copy guard (CORE-83 / D11). */", 1],
    ["// the F04 shape, where the failure", 1],
    ["// see plan §14.5 for the bytes", 1],
    ["// see PLAN.md Section 3", 1],
    ["// a core.longpaths setting and the F key", 0],
    ["// the plan step of the add repository flow", 0],
    ["const hex = 0xF04;", 0],
    ["A".repeat(40) + "F04" + "B".repeat(40), 0],
  ];
  for (const [text, want] of cases) {
    const got = internalReferences(text).length;
    if (got !== want) {
      throw new Error(`${JSON.stringify(text)}: found ${got}, wanted ${want}`);
    }
  }
});

test("no code or workflow names a task number, a bug code or the planning document", () => {
  const offenders: string[] = [];
  const paths = [
    ...SCANNED.flatMap((dir) => files(join(root, dir))),
    join(root, "action.yml"),
  ];
  for (const path of paths) {
    const name = relative(root, path).split(sep).join("/");
    if (name === self) continue;
    for (const found of internalReferences(readFileSync(path, "utf8"))) {
      offenders.push(`${name}: ${found}`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `internal references in code, say it in words instead:\n${offenders.slice(0, 20).join("\n")}`,
    );
  }
});
