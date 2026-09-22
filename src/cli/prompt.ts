/** Interactive prompts over `node:readline/promises`.
 *
 * Every prompt opens and closes its own interface: co-maintainer rarely asks
 * more than a couple of questions, and an interface left open keeps stdin
 * referenced, which would hang a non-interactive pipeline. */
import { createInterface } from "node:readline/promises";

/** Asks one question and always settles.
 *
 * `rl.question` never settles when stdin reaches EOF before an answer, which
 * is the F01 hang: `co-maintainer review </dev/null` awaited the answer
 * forever, printed `Warning: Detected unsettled top-level await`, and exited
 * 13. Racing the question against `close`/`end` and treating those as "no
 * answer" keeps the caller's fallback path alive instead. */
async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (
      await new Promise<string>((resolve) => {
        let settled = false;
        const done = (value: string): void => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        // `question` rejects when stdin closes mid-prompt (Ctrl-D, a detached
        // pipeline, a killed parent); treat that as "no answer" too.
        void rl.question(question).then(done, () => done(""));
        rl.once("close", () => done(""));
        process.stdin.once("end", () => done(""));
      })
    ).trim();
  } finally {
    rl.close();
  }
}

/** Free-text question; empty input yields the fallback (or ""). */
export async function askLine(
  label: string,
  fallback?: string,
): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = await ask(`${label}${suffix}:`);
  return answer || fallback || "";
}

/** Yes/no question; anything but `y`/`yes` is a no. */
export async function askConfirm(question: string): Promise<boolean> {
  const answer = (await ask(`${question} [y/N]`)).toLowerCase();
  return answer === "y" || answer === "yes";
}
