/** The App's installation webhooks, through `serve`: `installation` and
 * `installation_repositories`.
 *
 * A new installation is recorded with its account and permissions. A
 * repository removed from the installation stops being reviewed, and so does
 * every repository of an installation that is deleted. The checks read the
 * webhook answers, app.db rows and what was posted, never a model's answer. */
import type { AiRule } from "../fake_ai.ts";
import { check, type CheckResult, defineFlow, type Sim } from "../flow.ts";
import type { SimPull } from "../github.ts";
import { APP_REPO, OPENED_MATH, appRows, serveRepo } from "./app.ts";
import { INIT_AI } from "./init.ts";

const STEP = {
  served: "serve a repository with guides",
  created: "the App is installed on another account",
  removed: "the repository is removed from the installation",
  removedPull: "a pull request on the removed repository",
  deleted: "the other installation is deleted",
};

const OTHER_INSTALLATION = 777001;

const AI: AiRule[] = [
  ...INIT_AI,
  {
    name: "any review",
    job: "review_pull_request",
    prompt: /[\s\S]*/,
    reply: { findings: [] },
    optional: true,
  },
];

type Json = Record<string, unknown>;

function installationPayload(action: string, id: number): Json {
  return {
    action,
    installation: {
      id,
      account: { login: "sim-other-org", type: "Organization" },
      app_slug: "co-maintainer-sim",
      permissions: { pull_requests: "write", contents: "read" },
      events: ["pull_request", "issue_comment"],
    },
    sender: { login: "sim-owner", type: "User" },
  };
}

function reposPayload(sim: Sim, action: "added" | "removed"): Json {
  const key =
    action === "added" ? "repositories_added" : "repositories_removed";
  return {
    action,
    installation: {
      id: sim.github.installation.id,
      app_slug: "co-maintainer-sim",
    },
    [key]: [{ full_name: APP_REPO }],
    sender: { login: "sim-owner", type: "User" },
  };
}

function repoRow(sim: Sim) {
  return appRows<{ active: number; installation_id: number | null }>(
    sim,
    `SELECT active, installation_id FROM repos WHERE full_name = ?`,
    APP_REPO,
  )[0];
}

function installationRow(sim: Sim, id: number) {
  return appRows<Json>(sim, `SELECT * FROM installations WHERE id = ?`, id)[0];
}

function checks(sim: Sim): CheckResult[] {
  const created = sim.state.createdRow as Json | undefined;
  const deleted = installationRow(sim, OTHER_INSTALLATION);
  const removedReply = sim.state.removedReply as Json | undefined;
  const pullReply = sim.state.pullReply as Json | undefined;
  const pull = sim.state.pull as SimPull | undefined;
  const reviewsOnPull = pull
    ? sim.github.reviews.filter((review) => review.number === pull.number)
    : [];
  const pullJobs = sim.trace.jobs.filter(
    (job) => job.step === STEP.removedPull,
  );
  return [
    check(
      "a new installation is recorded with its account, type and permissions",
      created?.account_login === "sim-other-org" &&
        created.account_type === "Organization" &&
        String(created.permissions ?? "").includes("pull_requests"),
      created
        ? `${String(created.account_login)} · ${String(created.account_type)}`
        : "no row",
    ),
    check(
      "a repository removed from the installation is turned off",
      removedReply?.reason === "repositories-removed" &&
        sim.state.activeAfterRemove === 0,
      `${String(removedReply?.reason)} · active ${String(sim.state.activeAfterRemove)}`,
    ),
    check(
      "a pull request on the removed repository is skipped: no job, no review",
      pullReply?.outcome === "skipped" &&
        pullReply.reason === "repo-not-active" &&
        pullJobs.length === 0 &&
        reviewsOnPull.length === 0,
      `${String(pullReply?.outcome)} ${String(pullReply?.reason ?? "")} · ${pullJobs.length} jobs · ${reviewsOnPull.length} reviews`,
    ),
    check(
      "a deleted installation is marked removed",
      Boolean(deleted?.removed_at),
      deleted ? `removed_at ${String(deleted.removed_at ?? "none")}` : "no row",
    ),
  ];
}

export default defineFlow({
  name: "installation",
  description:
    "installation and installation_repositories webhooks: a new installation is recorded, a removed repository and a deleted installation stop reviews",
  ai: AI,
  steps: [
    {
      name: STEP.served,
      async run(sim) {
        await serveRepo(sim);
        return `${APP_REPO} · active ${String(repoRow(sim)?.active)}`;
      },
    },
    {
      name: STEP.created,
      async run(sim) {
        const reply = await sim.server.deliver(
          "installation",
          installationPayload("created", OTHER_INSTALLATION),
        );
        sim.state.createdRow = installationRow(sim, OTHER_INSTALLATION);
        return `${reply.status} · ${String(reply.body.reason)}`;
      },
    },
    {
      name: STEP.removed,
      async run(sim) {
        const reply = await sim.server.deliver(
          "installation_repositories",
          reposPayload(sim, "removed"),
        );
        sim.state.removedReply = reply.body;
        sim.state.activeAfterRemove = repoRow(sim)?.active;
        return `${String(reply.body.reason)} · active ${String(repoRow(sim)?.active)}`;
      },
    },
    {
      name: STEP.removedPull,
      async run(sim) {
        const pull = sim.github.openPull(APP_REPO, {
          title: "Add divide and average",
          files: { "src/math.ts": OPENED_MATH },
        });
        sim.state.pull = pull;
        const reply = await sim.server.deliver(
          "pull_request",
          sim.server.payloads.pullRequest(pull, "opened"),
        );
        await sim.server.runJobs();
        sim.state.pullReply = reply.body;
        return `${String(reply.body.outcome)} ${String(reply.body.reason ?? "")}`;
      },
    },
    {
      name: STEP.deleted,
      async run(sim) {
        const reply = await sim.server.deliver(
          "installation",
          installationPayload("deleted", OTHER_INSTALLATION),
        );
        return `${reply.status} · ${String(reply.body.reason)}`;
      },
    },
  ],
  checks,
});
