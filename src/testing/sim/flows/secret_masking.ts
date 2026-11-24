/** Secrets in code never reach the model.
 *
 * Fake secrets sit in the README that `init` reads, in a pull request's diff
 * (a token and a private key), and in its body. The flow runs `init` and a
 * CLI pull request review, and reads every AI request in the trace: each
 * secret was on GitHub, none was sent, and its mask was. The diff line after
 * the private key keeps its number. With `maskSecrets` off the next review
 * sends the secret, so the checks are not passing on an empty trace.
 *
 * The values are built at runtime, so no secret shape sits in this file. They
 * are not world secrets: the leak check would then also find them on GitHub
 * and in the sandbox, where they belong in this flow. Every check reads the
 * requests the product sent and the JSON it printed, never what the model
 * answered, so the flow passes with a real model too. */
import type { AiRule } from "../fake_ai.ts";
import { check, type CheckResult, defineFlow, type Sim } from "../flow.ts";
import { secretForms } from "../checks/common.ts";
import { SAMPLE_REPO } from "../sample_repo.ts";
import { INIT_AI } from "./init.ts";
import { parseJsonOutput, reviewCli } from "./cli_pr.ts";

const REPO = "sim/secrets";

const STEP = {
  guides: "init reads a README with a deploy key",
  review: "a pull request with a token, a private key and a key in its body",
  off: "the same review with maskSecrets off",
};

const join = (...parts: string[]) => parts.join("");
const INIT_KEY = join("sk-or-", "v1-", "init".repeat(8));
const DIFF_TOKEN = join("ghp", "_", "Diff".repeat(9));
const BODY_KEY = join("AKIA", "BODYKEY123456789");
const OFF_TOKEN = join("ghp", "_", "Off0".repeat(9));
const PEM_BODY = ["K".repeat(64), "L".repeat(64), "M".repeat(24)];
const PEM = [
  join("-----BEGIN ", "RSA PRIVATE KEY-----"),
  ...PEM_BODY,
  join("-----END ", "RSA PRIVATE KEY-----"),
];

/** Line 1 the token, lines 3 to 7 the key, line 9 the line to anchor on. */
const CONFIG = [
  `export const token = "${DIFF_TOKEN}"`,
  "export const key = `",
  ...PEM,
  "`",
  "export const retries = 3",
  "",
].join("\n");

const AI: AiRule[] = [
  ...INIT_AI,
  {
    name: "any review",
    job: "review_pull_request",
    prompt: /[\s\S]*/,
    reply: { findings: [] },
  },
];

/** Every AI request body sent while `step` ran, as one string. */
function sent(sim: Sim, step: string): string {
  return JSON.stringify([
    ...sim.trace.ai.filter((call) => call.step === step),
    ...sim.trace.completions.filter((call) => call.step === step),
  ]);
}

function leaked(text: string, value: string): boolean {
  return secretForms(value).some((form) => text.includes(form));
}

function onGithub(sim: Sim, value: string): boolean {
  return JSON.stringify(sim.trace.github).includes(value);
}

function warnings(sim: Sim): string[] {
  const json = sim.state.reviewJson as
    | { warnings?: { code?: string }[] }
    | undefined;
  return (json?.warnings ?? []).map((warning) => String(warning.code));
}

function checks(sim: Sim): CheckResult[] {
  const guides = sent(sim, STEP.guides);
  const review = sent(sim, STEP.review);
  const off = sent(sim, STEP.off);
  const reviewSecrets = [DIFF_TOKEN, BODY_KEY, ...PEM_BODY];
  const readmeSent = guides.includes("Deploy with");
  return [
    check(
      "init: the README's key is not in any request, its mask is",
      readmeSent &&
        !leaked(guides, INIT_KEY) &&
        guides.includes("[redacted:openrouter-key]"),
      `README sent ${readmeSent} · key ${leaked(guides, INIT_KEY) ? "sent" : "not sent"} · mask ${guides.includes("[redacted:openrouter-key]")}`,
    ),
    check(
      "review: the token, the private key and the body's key were on GitHub",
      reviewSecrets.every((value) => onGithub(sim, value)),
      reviewSecrets.map((value) => onGithub(sim, value)).join(", "),
    ),
    check(
      "review: none of them is in any request, and each one's mask is",
      reviewSecrets.every((value) => !leaked(review, value)) &&
        review.includes("[redacted:github-token]") &&
        review.includes("[redacted:aws-access-key]") &&
        review.includes("[redacted:private-key]"),
      reviewSecrets
        .map((value) => (leaked(review, value) ? "sent" : "masked"))
        .join(", "),
    ),
    check(
      "review: the private key keeps its lines and their diff markers, so the line after it is still line 9",
      /\b9 \+export const retries = 3/.test(review.replaceAll("\\n", "\n")) &&
        /\b4 \+\[redacted:private-key\]/.test(review.replaceAll("\\n", "\n")),
      `line 9 ${/\b9 \+export const retries = 3/.test(review.replaceAll("\\n", "\n")) ? "kept" : "moved"}`,
    ),
    check(
      "review: the JSON output warns that secrets were masked",
      warnings(sim).includes("secrets_masked"),
      warnings(sim).join(", ") || "no warnings",
    ),
    check(
      "maskSecrets off: the token is sent, so the checks above are not empty",
      onGithub(sim, OFF_TOKEN) && leaked(off, OFF_TOKEN),
      `on GitHub ${onGithub(sim, OFF_TOKEN)} · sent ${leaked(off, OFF_TOKEN)}`,
    ),
  ];
}

export default defineFlow({
  name: "secret-masking",
  description:
    "secrets in a README, a diff and a pull request body are masked before init and review reach the model, unless maskSecrets is off",
  ai: AI,
  steps: [
    {
      name: STEP.guides,
      async run(sim) {
        sim.repo(REPO, {
          ...SAMPLE_REPO,
          "README.md": `${SAMPLE_REPO["README.md"] ?? "# sample\n"}\nDeploy with ${INIT_KEY} as the key.\n`,
        });
        const { runInitOrRemake } = await import("../../../services/setup.ts");
        await runInitOrRemake(sim.options({ command: "init", repo: REPO }));
        return `${REPO} · guides written by init`;
      },
    },
    {
      name: STEP.review,
      async run(sim) {
        const pull = sim.github.openPull(REPO, {
          title: "Add the deploy config",
          body: `Uses the CI key ${BODY_KEY} for now.`,
          files: { "src/config.ts": CONFIG },
        });
        const run = await reviewCli(sim, pull.number, ["--json"], REPO);
        sim.state.reviewJson = parseJsonOutput(run.stdout);
        return `#${pull.number} · exit ${run.exitCode}`;
      },
    },
    {
      name: STEP.off,
      async run(sim) {
        sim.world.writeConfig({ maskSecrets: false });
        const pull = sim.github.openPull(REPO, {
          title: "Add the second token",
          files: { "src/other.ts": `export const other = "${OFF_TOKEN}"\n` },
        });
        const run = await reviewCli(sim, pull.number, ["--json"], REPO);
        sim.world.writeConfig({ maskSecrets: true });
        return `#${pull.number} · exit ${run.exitCode}`;
      },
    },
  ],
  checks,
});
