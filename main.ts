#!/usr/bin/env node
import { run } from "./src/cli/main.ts";

try {
  await run(process.argv.slice(2));
} catch (error) {
  console.error(
    `[error] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
