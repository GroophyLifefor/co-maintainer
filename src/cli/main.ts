/** CLI dispatch only. Each branch parses nothing itself beyond `args[0]` and
 * calls straight into a command or a service — see PLAN.md Section 3. */
import { parseArgs } from "./args.ts";
import { runServe } from "./commands/serve.ts";
import { runSet } from "./commands/set.ts";
import { runProbe } from "./commands/probe.ts";
import { runReview } from "./commands/review.ts";
import { runInitOrRemake } from "../services/setup.ts";

export async function run(args: string[]): Promise<void> {
  if (args[0] === "set") {
    await runSet(args.slice(1));
    return;
  }
  if (args[0] === "serve") {
    await runServe(args.slice(1));
    return;
  }
  const options = parseArgs(args);
  if (options.command === "probe") await runProbe(options);
  else if (options.command === "review") await runReview(options);
  else await runInitOrRemake(options);
}
