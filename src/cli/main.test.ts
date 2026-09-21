import { test } from "node:test";
import { run } from "./main.ts";
import { VERSION } from "../version.ts";

for (const flag of ["-v", "--version"]) {
  test(`${flag} prints the package version and needs no other arguments`, async () => {
    const original = console.log;
    const lines: string[] = [];
    console.log = (line: string) => lines.push(line);
    try {
      await run([flag]);
    } finally {
      console.log = original;
    }
    if (lines.length !== 1 || lines[0] !== VERSION) {
      throw new Error(`expected ${VERSION}, got ${JSON.stringify(lines)}`);
    }
  });
}
