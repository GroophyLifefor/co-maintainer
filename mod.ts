import { run } from "./src/cli/main.ts";

export { run };
export type {
  AiProvider,
  AiRequest,
  AiResponse,
  GitHubClient,
  Json,
  Options,
} from "./src/types.ts";
export type {
  Fact,
  PullRequest,
  Source,
  State,
} from "./src/knowledge/types.ts";

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
