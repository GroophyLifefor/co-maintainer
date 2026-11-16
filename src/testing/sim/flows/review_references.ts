/** Review references: a finding names the guide rules it rests on, code turns
 * the ids into references from `RULES.json`, and they are stored with the
 * finding. A review comment shows them only after the repository turns them
 * on, and turning them on makes the next sync read every pull request again
 * once, so its rules get links to the review comments they came from.
 *
 * The base guide-sources history is reused. The fake reviewer cites the
 * first rule id and the first codebase section it finds in its prompt, plus
 * one id that does not exist, which must be dropped. */
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { AiCall, AiReply, AiRule } from "../fake_ai.ts";
import {
  type CheckResult,
  type CliRun,
  check,
  defineFlow,
  scriptedCheck,
  type Sim,
} from "../flow.ts";
import type { Json } from "../../../types.ts";
import { GUIDE_SOURCES_AI } from "./guide_sources.ts";
import {
  buildHistory,
  HISTORY_REPO,
  runInit,
  runSync,
  type SetupRun,
} from "./init_sync.ts";
import {
  LOCAL_CHANGE,
  makeCheckout,
  NO_CODEGRAPH,
  type ReviewRun,
  reviewerRule,
  runReview,
} from "./local.ts";

const MADE_UP = "R999";

/** The base reviewer, with every finding citing what its prompt offers. */
const citingReviewer: AiRule = {
  name: "reviewer citing rules",
  job: /^review_(local|pull_request_retry)$/,
  reply: (call: AiCall) => {
    const base = reviewerRule().reply as (call: AiCall) => AiReply;
    const reply = base(call) as { json: { findings: Json[] } };
    const rule = /\[(R[1-9]\d*)\]/.exec(call.prompt)?.[1];
    const section = /CODEBASE CONVENTIONS:\n[\s\S]*?^## (.+)$/m.exec(
      call.prompt,
    )?.[1];
    const references = [
      ...(rule ? [rule] : []),
      ...(section ? [`codebase:${section}`] : []),
      MADE_UP,
    ];
    return {
      ...reply,
      json: {
        ...reply.json,
        findings: reply.json.findings.map((finding) => ({
          ...finding,
          references,
        })),
      },
    };
  },
};

export const REVIEW_REFERENCES_AI: AiRule[] = [
  citingReviewer,
  ...GUIDE_SOURCES_AI,
];

type RuleSource = { pr?: number; mergedAt?: string; url?: string };
type Reference = {
  kind: string;
  id?: string;
  section?: string;
  sources?: RuleSource[];
};

function read(sim: Sim, name: string): string {
  const path = `${sim.paths.reposDir}/${HISTORY_REPO}/${name}`;
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function rules(sim: Sim): Record<string, { sources: RuleSource[] }> {
  try {
    return JSON.parse(read(sim, "RULES.json")).rules ?? {};
  } catch {
    return {};
  }
}

/** Takes the comment links off every cached pull request, the way a row
 * cached before 0.7.3 looks. */
function forgetLinks(sim: Sim): number {
  const database = new DatabaseSync(sim.paths.cacheDb);
  try {
    const result = database
      .prepare(
        `UPDATE cache SET value = json_remove(value, '$.commentUrls', '$.reviewCommentUrls', '$.reviewUrls')
         WHERE namespace = 'pr' AND cache_key LIKE ?`,
      )
      .run(`${HISTORY_REPO}:%`);
    return Number(result.changes);
  } finally {
    database.close();
  }
}

/** The pull request comment reads a run made. */
function commentReads(run: CliRun | undefined): number {
  return (run?.github() ?? []).filter((call) =>
    /\/pulls\/\d+\/comments/.test(call.url),
  ).length;
}

const BACKFILL_LINE = "reading every pull request again once for comment links";

export const STEP = {
  history: "repository with history",
  init: "init with pull requests",
  reviewOff: "review with references off",
  turnOn: "set --review-references=on",
  reviewOn: "review with references on",
  backfill: "sync after turning references on",
  again: "a second sync",
} as const;

export default defineFlow({
  name: "review-references",
  description:
    "review findings name the rules they rest on, a comment shows them once a repository turns them on, and that reads every pull request again once for links",
  ai: REVIEW_REFERENCES_AI,
  steps: [
    {
      name: STEP.history,
      run(sim) {
        buildHistory(sim);
        return `${sim.github.pulls.length} pull requests`;
      },
    },
    {
      name: STEP.init,
      async run(sim) {
        sim.state.init = await runInit(sim);
        return `${Object.keys(rules(sim)).length} rules`;
      },
    },
    {
      name: STEP.reviewOff,
      async run(sim) {
        const checkout = makeCheckout(sim, {
          name: "references-off",
          repo: HISTORY_REPO,
          committed: LOCAL_CHANGE.committed,
        });
        const json = await runReview(sim, checkout, STEP.reviewOff, [
          NO_CODEGRAPH,
          "--json",
          "--fresh",
        ]);
        const human = await runReview(sim, checkout, STEP.reviewOff, [
          NO_CODEGRAPH,
          "--fresh",
        ]);
        // What the review resolved against, before later syncs change it.
        sim.state.rulesAtReview = rules(sim);
        sim.state.reviewOff = { json, human };
        return `exit ${json.cli.exitCode} and ${human.cli.exitCode}`;
      },
    },
    {
      name: STEP.turnOn,
      async run(sim) {
        const run = await sim.cli([
          "set",
          `--repo=${HISTORY_REPO}`,
          "--review-references=on",
        ]);
        sim.state.turnOn = run;
        return `exit ${run.exitCode}`;
      },
    },
    {
      name: STEP.reviewOn,
      async run(sim) {
        const checkout = makeCheckout(sim, {
          name: "references-on",
          repo: HISTORY_REPO,
          committed: LOCAL_CHANGE.committed,
        });
        const human = await runReview(sim, checkout, STEP.reviewOn, [
          NO_CODEGRAPH,
          "--fresh",
        ]);
        sim.state.reviewOn = human;
        return `exit ${human.cli.exitCode}`;
      },
    },
    {
      name: STEP.backfill,
      async run(sim) {
        const forgotten = forgetLinks(sim);
        sim.state.backfill = await runSync(sim);
        return `${forgotten} cached pull requests without links`;
      },
    },
    {
      name: STEP.again,
      async run(sim) {
        const forgotten = forgetLinks(sim);
        sim.state.again = await runSync(sim);
        return `${forgotten} cached pull requests without links`;
      },
    },
  ],
  checks: referenceChecks,
  scores: () => [],
});

function findingsOf(run: ReviewRun | undefined): Json[] {
  const findings = run?.json?.findings;
  return Array.isArray(findings) ? (findings as Json[]) : [];
}

export async function referenceChecks(sim: Sim): Promise<CheckResult[]> {
  const off = sim.state.reviewOff as
    | { json: ReviewRun; human: ReviewRun }
    | undefined;
  const on = sim.state.reviewOn as ReviewRun | undefined;
  const turnOn = sim.state.turnOn as CliRun | undefined;
  const backfill = sim.state.backfill as SetupRun | undefined;
  const again = sim.state.again as SetupRun | undefined;
  const built = (sim.state.rulesAtReview ?? {}) as Record<
    string,
    { sources: RuleSource[] }
  >;
  const findings = findingsOf(off?.json);
  const references = findings.map(
    (finding) => (finding.references ?? []) as Reference[],
  );
  const ruleRefs = references.flatMap((list) =>
    list.filter((item) => item.kind === "rule"),
  );
  const wrongSources = ruleRefs.filter(
    (item) =>
      JSON.stringify(item.sources) !==
      JSON.stringify(built[item.id ?? ""]?.sources),
  );
  const backfillReads = commentReads(backfill);
  const againReads = commentReads(again);
  const config = sim.world.readConfig() as {
    repos?: Record<
      string,
      { reviewReferences?: boolean; referencesBackfilledAt?: string }
    >;
  };
  const repoConfig = config.repos?.[HISTORY_REPO];
  return [
    scriptedCheck(
      sim,
      "every finding carries the rule it cited, with the pull requests and links RULES.json has",
      findings.length > 0 &&
        references.every((list) => list.some((item) => item.kind === "rule")) &&
        wrongSources.length === 0,
      `${findings.length} findings · ${ruleRefs.length} rule references · ${wrongSources.length} not matching RULES.json`,
      "the cited ids are the fake reviewer's",
    ),
    scriptedCheck(
      sim,
      "an id that is not in RULES.json is dropped, a codebase section is kept",
      references.length > 0 &&
        references.every(
          (list) =>
            !list.some((item) => item.id === MADE_UP) &&
            list.some((item) => item.kind === "codebase" && item.section),
        ),
      JSON.stringify(references[0] ?? []),
      "the cited ids are the fake reviewer's",
    ),
    check(
      "with references off the terminal output has no References block",
      off?.human.cli.exitCode !== undefined &&
        !off.human.cli.stdout.includes("References ("),
      `exit ${off?.human.cli.exitCode}`,
    ),
    check(
      "turning references on says the next sync reads every pull request again once",
      turnOn?.exitCode === 0 &&
        turnOn.stdout.includes("reads every pull request again once") &&
        repoConfig?.reviewReferences === true,
      `exit ${turnOn?.exitCode} · reviewReferences=${repoConfig?.reviewReferences}`,
    ),
    scriptedCheck(
      sim,
      "with references on the terminal output lists them under each finding",
      on?.cli.stdout.includes("References (") === true &&
        /- Rules-\d+ · #\d+/.test(on.cli.stdout),
      on?.cli.stdout.split("\n").find((line) => line.includes("Rules-")) ??
        "no Rules- line",
      "the cited ids are the fake reviewer's",
    ),
    check(
      "the first sync after turning references on reads the pull request comments again, once",
      backfill?.exitCode === 0 &&
        backfill.stderr.includes(BACKFILL_LINE) &&
        backfillReads > 0 &&
        typeof repoConfig?.referencesBackfilledAt === "string",
      `${backfillReads} comment reads · backfilled at ${repoConfig?.referencesBackfilledAt ?? "never"}`,
    ),
    check(
      "a later sync does not read them again",
      again?.exitCode === 0 &&
        !again.stderr.includes(BACKFILL_LINE) &&
        againReads === 0,
      `${againReads} comment reads`,
    ),
  ];
}
