/** Interactive prompts over `node:readline/promises`.
 *
 * Every prompt opens and closes its own interface: co-maintainer rarely asks
 * more than a couple of questions, and an interface left open keeps stdin
 * referenced, which would hang a non-interactive pipeline. */
import { createInterface } from "node:readline/promises";

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
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
