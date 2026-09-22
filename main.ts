#!/usr/bin/env node
import { reportCliError, run } from "./src/cli/main.ts";

try {
  await run(process.argv.slice(2));
} catch (error) {
  reportCliError(error);
}
