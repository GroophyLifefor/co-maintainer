/** Who decides a finding: a withdrawal that clears the last blocker approves
 * the commit (#144), a maintainer closes a finding from the dashboard or with
 * `/co-maintainer dismiss` and opens it again, a member the policy does not
 * list cannot, a repository in comment mode never approves or blocks, and the
 * diff limits follow the repository's settings. A maintainer who asks in
 * plain words closes a finding even when the model disagrees, the bot asks
 * what was wrong, and the answer is kept as feedback.
 *
 * The withdrawal checks depend on the scripted reply, so a live model that
 * keeps its finding skips them with a reason. The rest read what the product
 * wrote. */
import type { AiRule } from "../fake_ai.ts";
import { finding } from "../fake_ai.ts";
import {
  check,
  defineFlow,
  scriptedCheck,
  type CheckResult,
  type Sim,
} from "../flow.ts";
import type { SimPull } from "../github.ts";
import { APP_REPO, OPENED_MATH, appRows, serveRepo, writesIn } from "./app.ts";
import { INIT_AI } from "./init.ts";

const STEP = {
  served: "serve a repository with guides",
  opened: "a review that blocks on one finding",
  withdrawn: "the bot withdraws its only blocking finding",
  reopened: "a maintainer opens it again from the dashboard",
  stranger:
    "someone with no standing argues the finding is wrong and the bot agrees",
  member: "a member the policy does not list tries to dismiss",
  dismissed: "the owner dismisses it in its thread",
  memberAsks: "a member asks in plain words to close it",
  ownerAsks: "the owner asks in plain words to close it",
  feedback: "the owner says what was wrong with it",
  commentMode: "a repository in comment mode",
  limits: "the diff limits follow the repository",
  flags: "--ai-key and a saved pat on a pull request review",
  noneProvider: "init with --ai=none",
};

const AI: AiRule[] = [
  ...INIT_AI,
  {
    name: "one blocking finding",
    job: "review_pull_request",
    prompt: /[\s\S]*/,
    reply: {
      findings: [
        finding({
          path: "src/math.ts",
          line: 10,
          severity: "P1",
          blocking: true,
          title: "divide does not guard a zero divisor",
          body: "divide returns Infinity when b is 0.",
        }),
      ],
    },
  },
  // Each later reply's prompt carries the thread so far, so the rule for the
  // newest comment comes first.
  {
    name: "thanks for the feedback",
    job: "reply_to_github_comment",
    prompt: /The caller validates b before divide runs/,
    reply: "Thanks, that helps.",
  },
  {
    name: "closed as the owner asked",
    job: "reply_to_github_comment",
    prompt: /This finding is wrong, close it/,
    reply:
      "Closed it. I still read it the other way, but you know this code better. What was the problem with the finding, so I can get better?\n\nCLOSED",
  },
  {
    // The model writes the close line anyway: the product must not close.
    name: "a member asks to close",
    job: "reply_to_github_comment",
    prompt: /Please close this finding, it does not apply/,
    reply:
      "A maintainer can close it with `/co-maintainer dismiss`. What was the problem with it?\n\nCLOSED",
  },
  {
    name: "the bot agrees it was wrong",
    job: "reply_to_github_comment",
    prompt: /[\s\S]*/,
    reply: "You are right, callers check b first.\n\nWITHDRAWN",
  },
];

const pullOf = (sim: Sim) => sim.state.pull as SimPull;

function reviewEvents(sim: Sim, step: string): string[] {
  return writesIn(sim, step)
    .filter((write) => write.method === "POST" && /\/reviews$/.test(write.path))
    .map((write) => String((write.body as { event?: unknown }).event ?? ""));
}

function reviewBodies(sim: Sim, step: string): string[] {
  return writesIn(sim, step)
    .filter((write) => write.method === "POST" && /\/reviews$/.test(write.path))
    .map((write) => String((write.body as { body?: unknown }).body ?? ""));
}

function findingState(sim: Sim): { state: string; reason: string | null } {
  return (
    appRows<{ state: string; close_reason: string | null }>(
      sim,
      "SELECT state, close_reason FROM findings ORDER BY rowid DESC LIMIT 1",
    ).map((row) => ({ state: row.state, reason: row.close_reason }))[0] ?? {
      state: "none",
      reason: null,
    }
  );
}

/** The system text of the reply calls in a step. */
function replySystems(sim: Sim, step: string): string[] {
  return sim.trace.ai
    .filter(
      (call) => call.step === step && call.job === "reply_to_github_comment",
    )
    .map((call) => JSON.stringify(call.request ?? ""));
}

/** The reply bodies posted in a step's threads. */
function threadReplies(sim: Sim, step: string): string[] {
  return writesIn(sim, step)
    .filter(
      (write) =>
        write.method === "POST" && /\/pulls\/\d+\/comments$/.test(write.path),
    )
    .map((write) => String((write.body as { body?: unknown }).body ?? ""));
}

/** Opens the newest finding again from the dashboard. */
async function reopenLatest(sim: Sim): Promise<number | undefined> {
  const { handleFindingsRoute } =
    await import("../../../server/api/findings.ts");
  const id = appRows<{ id: string }>(
    sim,
    "SELECT id FROM findings ORDER BY rowid DESC LIMIT 1",
  )[0]?.id;
  const path = `/api/findings/${id}`;
  const response = await handleFindingsRoute(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-requested-with": "fetch",
      },
      body: JSON.stringify({ action: "reopen" }),
    }),
    new URL(`http://localhost${path}`),
  );
  return response?.status;
}

/** Someone replies in the finding's thread, and the jobs it queued run. */
async function replyInThread(
  sim: Sim,
  body: string,
  association: string,
): Promise<string> {
  const pull = pullOf(sim);
  const target = appRows<{ posted_comment_id: string }>(
    sim,
    "SELECT posted_comment_id FROM findings WHERE posted_comment_id IS NOT NULL ORDER BY rowid LIMIT 1",
  )[0];
  const comment = sim.github.reviewComment(pull, {
    body,
    inReplyTo: Number(target?.posted_comment_id),
    user: "sim-owner",
    association,
  });
  const delivery = await sim.server.deliver(
    "pull_request_review_comment",
    sim.server.payloads.reviewComment(pull, comment),
  );
  const jobs = await sim.server.runJobs();
  return `${String(delivery.body.outcome)} · ${jobs.map((job) => `${job.type} ${job.status}`).join(", ") || "no job"}`;
}

function checks(sim: Sim): CheckResult[] {
  const state = sim.state as Record<string, Record<string, unknown>>;
  const withdrawn = state.withdrawn ?? {};
  const reopened = state.reopened ?? {};
  const member = state.member ?? {};
  const stranger = state.stranger ?? {};
  const dismissed = state.dismissed ?? {};
  const limits = state.limits ?? {};
  const flags = state.flags ?? {};
  const memberAsks = state.memberAsks ?? {};
  const ownerAsks = state.ownerAsks ?? {};
  const feedback = state.feedback ?? {};
  const markerPosted = [STEP.memberAsks, STEP.ownerAsks].some((step) =>
    threadReplies(sim, step).some((body) => /^CLOSED$/m.test(body)),
  );
  return [
    scriptedCheck(
      sim,
      "the first review requests changes on its blocking finding",
      reviewEvents(sim, STEP.opened).includes("REQUEST_CHANGES"),
      reviewEvents(sim, STEP.opened).join(", "),
      "a live model decides itself whether a finding blocks",
    ),
    scriptedCheck(
      sim,
      "withdrawing the last blocking finding approves the reviewed commit with the fixed text",
      reviewEvents(sim, STEP.withdrawn).includes("APPROVE") &&
        reviewBodies(sim, STEP.withdrawn).some((body) =>
          body.includes("was withdrawn, so no blocking finding is left open"),
        ),
      `${reviewEvents(sim, STEP.withdrawn).join(", ") || "no review"} · finding ${JSON.stringify(withdrawn)}`,
      "a live model decides itself whether to withdraw",
    ),
    scriptedCheck(
      sim,
      "the dashboard opens a withdrawn finding again",
      reopened.status === 200 && reopened.state === "open",
      JSON.stringify(reopened),
      "only a withdrawn finding can be opened again",
    ),
    scriptedCheck(
      sim,
      "a commenter who may not close findings cannot get the bot to withdraw one or to approve: the finding stays open, nothing is approved, and the marker line is not posted",
      stranger.before === "open" &&
        stranger.after === "open" &&
        !reviewEvents(sim, STEP.stranger).includes("APPROVE") &&
        threadReplies(sim, STEP.stranger).length === 1 &&
        !threadReplies(sim, STEP.stranger).some((body) =>
          /^WITHDRAWN$/m.test(body),
        ) &&
        !replySystems(sim, STEP.stranger).some((text) =>
          text.includes("WITHDRAWN"),
        ),
      `${JSON.stringify(stranger)} · reviews ${reviewEvents(sim, STEP.stranger).join(", ") || "none"}`,
      "a live model decides itself what to answer",
    ),
    check(
      "a member the policy does not list cannot dismiss: no job, the finding stays as it was",
      member.outcome === "skipped" && member.changed === false,
      JSON.stringify(member),
    ),
    check(
      "the owner's /co-maintainer dismiss closes the finding as dismissed and answers in the thread",
      dismissed.state === "closed" &&
        dismissed.reason === "dismissed" &&
        dismissed.replied === true,
      JSON.stringify(dismissed),
    ),
    scriptedCheck(
      sim,
      "dismissing the last blocking finding approves the reviewed commit",
      reviewEvents(sim, STEP.dismissed).includes("APPROVE"),
      reviewEvents(sim, STEP.dismissed).join(", ") || "no review",
      "only a blocking finding left open makes the dismissal approve",
    ),
    check(
      "a member's plain request to close leaves the finding open, and the prompt says a maintainer can close it",
      memberAsks.reopened === 200 &&
        memberAsks.state !== "closed" &&
        replySystems(sim, STEP.memberAsks).some((text) =>
          text.includes("a maintainer can close it"),
        ),
      JSON.stringify(memberAsks),
    ),
    check(
      "the owner's plain request to close reaches the model with the close and feedback rule",
      replySystems(sim, STEP.ownerAsks).some(
        (text) =>
          text.includes("close it, even if you still think it is right") &&
          text.includes("what the problem with the finding was"),
      ),
      `${replySystems(sim, STEP.ownerAsks).length} reply call(s)`,
    ),
    check(
      "the close line is never posted",
      !markerPosted,
      markerPosted ? "posted" : "kept out of every reply",
    ),
    scriptedCheck(
      sim,
      "the owner's plain request closes the finding as dismissed, and the reply asks what was wrong",
      ownerAsks.state === "closed" &&
        ownerAsks.reason === "dismissed" &&
        threadReplies(sim, STEP.ownerAsks).some((body) =>
          body.includes("What was the problem with the finding"),
        ),
      JSON.stringify(ownerAsks),
      "a live model decides itself whether the comment asks to close",
    ),
    scriptedCheck(
      sim,
      "the answer on a closed finding is kept in the audit log as feedback",
      Number(feedback.kept) === 1,
      JSON.stringify(feedback),
      "only a finding the model closed gets feedback",
    ),
    check(
      "a repository in comment mode posts its review as a comment, never approving or blocking",
      reviewEvents(sim, STEP.commentMode).length > 0 &&
        reviewEvents(sim, STEP.commentMode).every(
          (event) => event === "COMMENT",
        ),
      reviewEvents(sim, STEP.commentMode).join(", ") || "no review",
    ),
    check(
      "a repository's file patch limit cuts a patch the default keeps whole, and 0 means no limit",
      limits.defaultState === "full" &&
        limits.smallLimit === "partial" &&
        limits.noLimit === "full",
      JSON.stringify(limits),
    ),
    check(
      "--ai-key works on review like --token, and a saved pat does not stop a pull request review",
      flags.key === "sim-ai-key-flag" && flags.auth === "gh",
      JSON.stringify(flags),
    ),
    check(
      "init with --ai=none stops with exit code 2 and says init and sync need a provider",
      (sim.state.noneProvider as Record<string, unknown> | undefined)?.code ===
        2 &&
        String(
          (sim.state.noneProvider as Record<string, unknown> | undefined)
            ?.message,
        ).includes("init and sync need an AI provider"),
      JSON.stringify(sim.state.noneProvider),
    ),
  ];
}

export default defineFlow({
  name: "finding-control",
  description:
    "withdrawals and maintainer dismissals approve once nothing blocks, comment mode never decides, and diff limits follow the repository",
  ai: AI,
  steps: [
    {
      name: STEP.served,
      async run(sim) {
        await serveRepo(sim);
        return `${APP_REPO} · guides built · auto review on`;
      },
    },
    {
      name: STEP.opened,
      async run(sim) {
        const pull = sim.github.openPull(APP_REPO, {
          title: "Add divide and average",
          files: { "src/math.ts": OPENED_MATH },
        });
        sim.state.pull = pull;
        await sim.server.deliver(
          "pull_request",
          sim.server.payloads.pullRequest(pull, "opened"),
        );
        const jobs = await sim.server.runJobs();
        return jobs.map((job) => `${job.type} ${job.status}`).join(", ");
      },
    },
    {
      name: STEP.withdrawn,
      async run(sim) {
        const line = await replyInThread(
          sim,
          "Callers always check b before calling divide, see src/calc.ts.",
          "OWNER",
        );
        sim.state.withdrawn = findingState(sim);
        return line;
      },
    },
    {
      name: STEP.reopened,
      async run(sim) {
        const status = await reopenLatest(sim);
        sim.state.reopened = {
          status,
          state: findingState(sim).state,
        };
        return JSON.stringify(sim.state.reopened);
      },
    },
    {
      name: STEP.stranger,
      async run(sim) {
        const before = findingState(sim);
        const line = await replyInThread(
          sim,
          "Callers always check b before calling divide, so this finding is wrong.",
          "NONE",
        );
        const after = findingState(sim);
        sim.state.stranger = {
          before: before.state,
          after: after.state,
          reason: after.reason,
        };
        return line;
      },
    },
    {
      name: STEP.member,
      async run(sim) {
        const before = findingState(sim);
        const line = await replyInThread(
          sim,
          "/co-maintainer dismiss nope",
          "MEMBER",
        );
        const after = findingState(sim);
        sim.state.member = {
          outcome: line.split(" · ")[0],
          changed:
            before.state !== after.state || before.reason !== after.reason,
        };
        return line;
      },
    },
    {
      name: STEP.dismissed,
      async run(sim) {
        const line = await replyInThread(
          sim,
          "/co-maintainer dismiss accepted risk for now",
          "OWNER",
        );
        const after = findingState(sim);
        const replied = writesIn(sim, STEP.dismissed).some(
          (write) =>
            /\/pulls\/\d+\/comments$/.test(write.path) &&
            String((write.body as { body?: unknown }).body ?? "").includes(
              "closed this finding: accepted risk for now",
            ),
        );
        sim.state.dismissed = { ...after, replied };
        return line;
      },
    },
    {
      name: STEP.memberAsks,
      async run(sim) {
        // Open again first: the dismissal above closed it.
        const reopened = await reopenLatest(sim);
        const line = await replyInThread(
          sim,
          "Please close this finding, it does not apply.",
          "MEMBER",
        );
        sim.state.memberAsks = { reopened, ...findingState(sim) };
        return line;
      },
    },
    {
      name: STEP.ownerAsks,
      async run(sim) {
        const line = await replyInThread(
          sim,
          "This finding is wrong, close it.",
          "OWNER",
        );
        sim.state.ownerAsks = findingState(sim);
        return line;
      },
    },
    {
      name: STEP.feedback,
      async run(sim) {
        const line = await replyInThread(
          sim,
          "The caller validates b before divide runs.",
          "OWNER",
        );
        const kept = appRows<{ n: number }>(
          sim,
          "SELECT COUNT(*) AS n FROM audit_log WHERE summary = 'Feedback on a closed finding' AND changes_json LIKE '%validates b before divide%'",
        )[0]?.n;
        sim.state.feedback = { kept };
        return line;
      },
    },
    {
      name: STEP.commentMode,
      async run(sim) {
        const repos = (sim.world.readConfig().repos ?? {}) as Record<
          string,
          Record<string, unknown>
        >;
        sim.world.writeConfig({
          repos: {
            ...repos,
            [APP_REPO]: { ...repos[APP_REPO], reviewEvent: "comment" },
          },
        });
        const pull = sim.github.openPull(APP_REPO, {
          title: "Add divide again",
          files: { "src/math.ts": OPENED_MATH },
        });
        await sim.server.deliver(
          "pull_request",
          sim.server.payloads.pullRequest(pull, "opened"),
        );
        const jobs = await sim.server.runJobs();
        return jobs.map((job) => `${job.type} ${job.status}`).join(", ");
      },
    },
    {
      name: STEP.limits,
      async run(sim) {
        const { planDiff, diffLimitsFrom } =
          await import("../../../pr/diff_plan.ts");
        const patch = `@@ -1,1 +1,40 @@\n${Array.from(
          { length: 40 },
          (_, index) => `+export const value${index} = ${index}`,
        ).join("\n")}`;
        const file = {
          path: "src/values.ts",
          previousPath: null,
          status: "added",
          additions: 40,
          deletions: 0,
          changes: 40,
          patch,
        };
        const stateWith = (repo: Record<string, number>) => {
          const limits = diffLimitsFrom(repo);
          return planDiff([file], limits.diff, limits.filePatch)[0]!.state;
        };
        sim.state.limits = {
          defaultState: stateWith({}),
          smallLimit: stateWith({ reviewFilePatchMaxChars: 200 }),
          noLimit: stateWith({ reviewFilePatchMaxChars: 0 }),
        };
        return JSON.stringify(sim.state.limits);
      },
    },
    {
      name: STEP.flags,
      async run(sim) {
        const { parseArgs } = await import("../../../cli/args.ts");
        const before = sim.world.readConfig();
        sim.world.writeConfig({ auth: "pat", githubPat: undefined });
        try {
          const options = await parseArgs([
            "review",
            APP_REPO,
            String(pullOf(sim).number),
            "--ai=openrouter",
            "--ai-key=sim-ai-key-flag",
            "--low-model=a",
            "--high-model=b",
          ]);
          sim.state.flags = { key: options.aiToken, auth: options.auth };
        } finally {
          sim.world.writeConfig({
            auth: before.auth,
            githubPat: before.githubPat,
          });
        }
        return JSON.stringify(sim.state.flags);
      },
    },
    {
      name: STEP.noneProvider,
      async run(sim) {
        const { createAiProvider } = await import("../../../ai/provider.ts");
        try {
          // `none` parses, as it always did. The run stops where a provider
          // is made, with words that say why.
          createAiProvider(
            { ...sim.options({ command: "init" }), ai: "none" },
            "unused",
          );
          sim.state.noneProvider = { code: 0, message: "accepted" };
        } catch (error) {
          const failure = error as { exitCode?: number; message?: string };
          sim.state.noneProvider = {
            code: failure.exitCode,
            message: failure.message,
          };
        }
        return JSON.stringify(sim.state.noneProvider);
      },
    },
  ],
  checks,
});
