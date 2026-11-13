/** A child process for `prompt_interrupt.test.ts`: asks one yes/no question
 * in a terminal and prints what happened. With `PROMPT_HANDLER=1` it has a
 * SIGINT handler, as a local review does. */
import { askConfirm } from "../../cli/prompt.ts";

if (process.env.PROMPT_HANDLER === "1") {
  process.on("SIGINT", () => {
    console.log("HANDLER RAN");
    process.exitCode = 3;
  });
}
const answer = await askConfirm("Install it?");
console.log(`ANSWER ${answer}`);
