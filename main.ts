import { run } from "./src/app.ts";

try {
  await run(Deno.args);
} catch (error) {
  console.error(
    `[error] ${error instanceof Error ? error.message : String(error)}`,
  );
  Deno.exit(1);
}
