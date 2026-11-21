/** A setting holds in every kind of review, and a flag a mode cannot honour
 * is refused instead of dropped: the client's own key reaches a push review,
 * the repository's exclude pattern reaches a remote review, server-owned and
 * unknown flags stop a remote review, and the references follow the server's
 * setting.
 *
 * The checks read app.db, the prompt the product built and the exit codes,
 * never the model's answer, so a real model passes them too. */
import type { AiRule } from "../fake_ai.ts";
import {
  check,
  defineFlow,
  scriptedCheck,
  type CheckResult,
  type Sim,
} from "../flow.ts";
import { SAMPLE_REPO, SAMPLE_REPO_NAME } from "../sample_repo.ts";
import { INIT_AI } from "./init.ts";
import { clientCheckout } from "./remote_support.ts";
import {
  PERCENT_OF_CHANGE,
  PUSH_AI,
  appRows,
  remoteSetupSteps,
  remoteState,
  runPushReview,
  runRemoteReview,
} from "./remote.ts";

const STEP = {
  byokPush: "a push review with the client's own key",
  requirePush: "a push without a key when the server requires one",
  exclude: "a remote review of a repository with an exclude pattern",
  flags: "flags a remote review cannot honour",
  references: "references follow the server's setting",
};

const EXCLUDED = Object.keys(PERCENT_OF_CHANGE)[0]!;

const AI: AiRule[] = [
  ...INIT_AI,
  ...PUSH_AI,
  {
    name: "any local review",
    job: "review_local",
    prompt: /[\s\S]*/,
    reply: { findings: [] },
    optional: true,
  },
  {
    name: "any push review",
    job: "review_push",
    prompt: /[\s\S]*/,
    reply: { findings: [] },
    optional: true,
  },
];

function pushCommit(sim: Sim, name: string) {
  return sim.github.commitToDefault(
    SAMPLE_REPO_NAME,
    {
      "src/math.ts": `${SAMPLE_REPO["src/math.ts"]}\nexport function lerp${name}(a: number, b: number, t: number): number {\n  return b + (a - b) * t;\n}\n`,
    },
    `Add lerp ${name}`,
  );
}

function checks(sim: Sim): CheckResult[] {
  const state = sim.state as Record<string, Record<string, unknown>>;
  const byok = state.byokPush ?? {};
  const require = state.requirePush ?? {};
  const exclude = state.exclude ?? {};
  const flags = state.flags ?? {};
  const references = state.references ?? {};
  return [
    check(
      "a push review sent with --remote-byok is billed to the client, and the key leaves memory after the job",
      byok.billedTo === "byok" && byok.keysHeld === 0,
      JSON.stringify(byok),
    ),
    scriptedCheck(
      sim,
      "the push review with the client's own key ends with exit 0",
      byok.exit === 0,
      `exit ${String(byok.exit)}`,
      "the client's key is a stand-in that a live provider refuses",
    ),
    check(
      "a push without a key is refused when the server requires one, and nothing is queued",
      require.exit !== 0 && require.newReviews === 0,
      JSON.stringify(require),
    ),
    check(
      "the repository's exclude pattern leaves the file out of a remote review and the prompt says so",
      exclude.note === true && exclude.fileInDiff === false,
      JSON.stringify(exclude),
    ),
    check(
      "a server-owned flag and an unknown flag stop a remote review with exit 2",
      flags.serverOwned === 2 && flags.unknown === 2,
      JSON.stringify(flags),
    ),
    check(
      "a prompt file with --range is refused with exit 2",
      flags.rangePrompt === 2,
      `exit ${String(flags.rangePrompt)}`,
    ),
    check(
      "the output shows references when the server says so, whatever this machine's config says",
      references.serverOn === true &&
        references.serverOff === false &&
        references.oldServer === false,
      JSON.stringify(references),
    ),
  ];
}

export default defineFlow({
  name: "mode-parity",
  description:
    "the client key, the exclude pattern and the references hold in push and remote reviews, and flags a mode cannot honour are refused",
  ai: AI,
  steps: [
    ...remoteSetupSteps(),
    {
      name: STEP.byokPush,
      async run(sim) {
        const range = pushCommit(sim, "Byok");
        const ci = clientCheckout(sim, SAMPLE_REPO_NAME, "ci-byok");
        // Kept out of the world's secrets, as the remote flow does: the one
        // submit body that must carry it would trip the leak check.
        const key = `sim-client-key-${crypto.randomUUID().replaceAll("-", "")}`;
        const before = process.env.CM_REMOTE_BYOK;
        process.env.CM_REMOTE_BYOK = key;
        let run;
        try {
          run = await runPushReview(sim, ci, range, [
            "--remote-byok",
            "--json",
          ]);
        } finally {
          if (before === undefined) delete process.env.CM_REMOTE_BYOK;
          else process.env.CM_REMOTE_BYOK = before;
        }
        const row = appRows<{ billed_to: string }>(
          sim,
          "SELECT billed_to FROM reviews WHERE kind = 'push' ORDER BY created_at DESC LIMIT 1",
        )[0];
        const { byokKeyCountForTest } =
          await import("../../../remote/server/byok_keys.ts");
        sim.state.byokPush = {
          exit: run.exitCode,
          billedTo: row?.billed_to,
          keysHeld: byokKeyCountForTest(),
        };
        return JSON.stringify(sim.state.byokPush);
      },
    },
    {
      name: STEP.requirePush,
      async run(sim) {
        const count = () =>
          appRows<{ n: number }>(
            sim,
            "SELECT COUNT(*) AS n FROM reviews WHERE kind = 'push'",
          )[0]?.n ?? 0;
        const before = count();
        sim.world.writeConfig({ remoteByokPolicy: "require" });
        const range = pushCommit(sim, "Required");
        const ci = clientCheckout(sim, SAMPLE_REPO_NAME, "ci-require");
        const run = await runPushReview(sim, ci, range, ["--json"]);
        sim.world.writeConfig({ remoteByokPolicy: "allow" });
        sim.state.requirePush = {
          exit: run.exitCode,
          newReviews: count() - before,
        };
        return JSON.stringify(sim.state.requirePush);
      },
    },
    {
      name: STEP.exclude,
      async run(sim) {
        const config = sim.world.readConfig();
        const repos = (config.repos ?? {}) as Record<
          string,
          Record<string, unknown>
        >;
        const pattern = EXCLUDED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        sim.world.writeConfig({
          repos: {
            ...repos,
            [SAMPLE_REPO_NAME]: {
              ...repos[SAMPLE_REPO_NAME],
              reviewExclude: `^${pattern}$`,
            },
          },
        });
        const { dev } = remoteState(sim);
        await runRemoteReview(sim, dev, ["--json", "--fresh"]);
        sim.world.writeConfig({ repos });
        const prompts = sim.trace.completions
          .filter((call) => call.step === STEP.exclude)
          .map((call) => call.firstUser);
        const diffParts = prompts.map(
          (prompt) => prompt.split("DIFF:")[1] ?? "",
        );
        sim.state.exclude = {
          prompts: prompts.length,
          note: prompts.some((prompt) =>
            prompt.includes("EXCLUDED BY THE REPOSITORY"),
          ),
          fileInDiff: diffParts.some((part) =>
            part.split("EXCLUDED BY THE REPOSITORY")[0]!.includes(EXCLUDED),
          ),
        };
        return JSON.stringify(sim.state.exclude);
      },
    },
    {
      name: STEP.flags,
      async run(sim) {
        const { dev } = remoteState(sim);
        const serverOwned = await runRemoteReview(sim, dev, [
          "--high-model=client-model",
        ]);
        const unknown = await runRemoteReview(sim, dev, ["--disable-codegrap"]);
        const rangePrompt = await runRemoteReview(sim, dev, [
          `--range=${"a".repeat(40)}..${"b".repeat(40)}`,
          "--system-prompt-file=instructions.md",
        ]);
        sim.state.flags = {
          serverOwned: serverOwned.exitCode,
          unknown: unknown.exitCode,
          rangePrompt: rangePrompt.exitCode,
        };
        return JSON.stringify(sim.state.flags);
      },
    },
    {
      name: STEP.references,
      async run(sim) {
        const { serverShowsReferences } =
          await import("../../../remote/client.ts");
        // This machine says on, the server decides.
        sim.world.writeConfig({
          repos: {
            ...((sim.world.readConfig().repos ?? {}) as Record<
              string,
              unknown
            >),
            "sim/elsewhere": { reviewReferences: true },
          },
        });
        sim.state.references = {
          serverOn: serverShowsReferences(
            { references: { show: true } },
            SAMPLE_REPO_NAME,
          ),
          serverOff: serverShowsReferences(
            { references: { show: false } },
            "sim/elsewhere",
          ),
          oldServer: serverShowsReferences({}, SAMPLE_REPO_NAME),
        };
        return JSON.stringify(sim.state.references);
      },
    },
  ],
  checks,
});
