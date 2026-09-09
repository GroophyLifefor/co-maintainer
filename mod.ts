import { run } from "./src/app.ts";

export { run };
export type {
  AiProvider,
  AiRequest,
  AiResponse,
  Fact,
  GitHubClient,
  Json,
  Options,
  PullRequest,
  Source,
  State,
} from "./src/types.ts";

if (import.meta.main) {
  try {
    await run(Deno.args);
  } catch (error) {
    console.error(
      `[error] ${error instanceof Error ? error.message : String(error)}`,
    );
    Deno.exit(1);
  }
}
