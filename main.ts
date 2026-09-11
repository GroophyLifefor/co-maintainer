import { run } from "./src/cli/main.ts";

try {
  await run(Deno.args);
} catch (error) {
  console.error(
    `[error] ${error instanceof Error ? error.message : String(error)}`,
  );
  Deno.exit(1);
}
