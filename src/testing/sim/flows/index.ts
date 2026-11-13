/** Every flow `e2e:simulate` runs: each file in this directory whose default
 * export is a flow, in file name order. A new flow is one new file and needs
 * no line anywhere else. A file without a default flow, such as a helper
 * module, is skipped. Two flows with one name are refused, so `--flow`
 * always means one flow. */
import { readdirSync } from "node:fs";
import type { Flow } from "../flow.ts";

function isFlow(value: unknown): value is Flow {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Flow).name === "string" &&
    Array.isArray((value as Flow).steps)
  );
}

const files = readdirSync(import.meta.dirname)
  .filter(
    (name) =>
      name.endsWith(".ts") && name !== "index.ts" && !name.endsWith(".test.ts"),
  )
  .sort();

export const FLOWS: Flow[] = [];
for (const file of files) {
  const module = (await import(`./${file}`)) as { default?: unknown };
  if (isFlow(module.default)) FLOWS.push(module.default);
}

const seen = new Map<string, string>();
for (const [index, flow] of FLOWS.entries()) {
  const other = seen.get(flow.name);
  if (other) {
    throw new Error(
      `Two flows are named ${flow.name}: ${other} and the one at position ${index + 1}. Flow names must be unique.`,
    );
  }
  seen.set(flow.name, `the one at position ${index + 1}`);
}
