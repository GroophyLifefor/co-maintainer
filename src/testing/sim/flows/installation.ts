/** The App's installation webhooks, through `serve`: `installation` and
 * `installation_repositories`.
 *
 * A new installation is recorded with its account and permissions. A
 * repository removed from the installation stops being reviewed, and so does
 * every repository of an installation that is deleted. A repository GitHub
 * removed and then added back stays off, the dashboard says so, and one
 * Resume turns it on without an init (issue 161). A reinstall takes the same
 * path, and a repository turned off by hand gets no notice. The checks read
 * the webhook answers, app.db rows, the dashboard's answers and what was
 * posted, never a model's answer. */
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
  returned: "the repository is added back to the installation",
  returnedPull: "a pull request before resume",
  resumeRefused: "resume without a session, then without the header",
  resumed: "the owner resumes reviews",
  resumedPull: "a pull request after resume",
  reinstalled: "the App is uninstalled and installed again",
  byHand: "a repository turned off by hand comes back",
};

const PASSWORD = "sim-dashboard-password";

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

async function dashboard() {
  const { createApp } = await import("../../../server/app.ts");
  const app = createApp({ password: PASSWORD });
  const login = await app.fetch(
    new Request("http://localhost/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `password=${PASSWORD}&next=/`,
    }),
  );
  const cookie = (login.headers.get("set-cookie") ?? "").split(/[;]/)[0] ?? "";
  return {
    page: async (path: string) =>
      (
        await app.fetch(
          new Request(`http://localhost${path}`, { headers: { cookie } }),
        )
      ).text(),
    resume: async (opts: { cookie?: boolean; header?: boolean } = {}) =>
      (
        await app.fetch(
          new Request(`http://localhost/api/repos/${APP_REPO}/resume`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(opts.cookie === false ? {} : { cookie }),
              ...(opts.header === false
                ? {}
                : { "x-requested-with": "co-maintainer" }),
            },
            body: "{}",
          }),
        )
      ).status,
    remove: async () =>
      (
        await app.fetch(
          new Request(`http://localhost/api/repos/${APP_REPO}`, {
            method: "DELETE",
            headers: { cookie, "x-requested-with": "co-maintainer" },
          }),
        )
      ).status,
  };
}

const NOTICE = "This repository is back in the installation";

async function openAndDeliver(sim: Sim, title: string) {
  const pull = sim.github.openPull(APP_REPO, {
    title,
    files: { "src/math.ts": OPENED_MATH },
  });
  const reply = await sim.server.deliver(
    "pull_request",
    sim.server.payloads.pullRequest(pull, "opened"),
  );
  const jobs = await sim.server.runJobs();
  return { pull, reply: reply.body, jobs };
}

function marks(sim: Sim) {
  return appRows<{
    active: number;
    removed_by_github_at: string | null;
    returned_at: string | null;
    installation_id: number | null;
  }>(
    sim,
    `SELECT active, removed_by_github_at, returned_at, installation_id FROM repos WHERE full_name = ?`,
    APP_REPO,
  )[0];
}

function auditOf(sim: Sim, summary: string) {
  return appRows<{ actor: string; target: string }>(
    sim,
    `SELECT actor, target FROM audit_log WHERE summary = ?`,
    summary,
  );
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
  const ret = sim.state.marksAfterReturn as ReturnType<typeof marks>;
  const cameBack = auditOf(sim, "A repository came back to the installation");
  const returnedPull = sim.state.returnedPull as
    | Awaited<ReturnType<typeof openAndDeliver>>
    | undefined;
  const resumed = sim.state.marksAfterResume as ReturnType<typeof marks>;
  const resumedAudit = auditOf(sim, "Resumed reviews on a repository");
  const resumedPull = sim.state.resumedPull as
    | Awaited<ReturnType<typeof openAndDeliver>>
    | undefined;
  const reinstalled = sim.state.marksAfterReinstall as ReturnType<typeof marks>;
  const byHand = sim.state.marksAfterByHand as ReturnType<typeof marks>;
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
    check(
      "a repository added back stays off, records that GitHub removed it and when it came back, and the return is audited as GitHub",
      ret?.active === 0 &&
        Boolean(ret.removed_by_github_at) &&
        Boolean(ret.returned_at) &&
        cameBack.some(
          (row) => row.actor === "GitHub" && row.target === APP_REPO,
        ),
      `active ${String(ret?.active)} · removed ${ret?.removed_by_github_at ? "set" : "empty"} · returned ${ret?.returned_at ? "set" : "empty"} · ${cameBack.length} audit rows`,
    ),
    check(
      "the dashboard home shows the notice with a Resume button",
      String(sim.state.homeAfterReturn ?? "").includes(NOTICE) &&
        String(sim.state.homeAfterReturn ?? "").includes(
          `data-resume="${APP_REPO}"`,
        ),
      String(sim.state.homeAfterReturn ?? "").includes(NOTICE)
        ? "notice shown"
        : "no notice",
    ),
    check(
      "a pull request before resume queues no review",
      returnedPull?.reply.outcome === "skipped" &&
        (returnedPull.jobs.length ?? 0) === 0,
      `${String(returnedPull?.reply.outcome)} ${String(returnedPull?.reply.reason ?? "")} · ${returnedPull?.jobs.length ?? 0} jobs`,
    ),
    check(
      "resume needs a session and the request header",
      sim.state.noCookie === 401 && sim.state.noHeader === 403,
      `no session ${String(sim.state.noCookie)} · no header ${String(sim.state.noHeader)}`,
    ),
    check(
      "resume turns it on without an init: 200, marks cleared, audited as the owner, no setup job, the notice gone, Knowledge shows what changed since",
      sim.state.resumeStatus === 200 &&
        resumed?.active === 1 &&
        !resumed.removed_by_github_at &&
        !resumed.returned_at &&
        resumedAudit.some((row) => row.actor === "admin") &&
        sim.state.setupJobsAfterResume === 0 &&
        !String(sim.state.homeAfterResume ?? "").includes(NOTICE) &&
        /Since then|Built/.test(String(sim.state.knowledgeAfterResume ?? "")),
      `status ${String(sim.state.resumeStatus)} · active ${String(resumed?.active)} · setup jobs ${String(sim.state.setupJobsAfterResume)} · audit ${resumedAudit.map((row) => row.actor).join(",") || "none"} · notice ${String(sim.state.homeAfterResume ?? "").includes(NOTICE) ? "still" : "gone"} · knowledge ${
        /Since then|Built/.test(String(sim.state.knowledgeAfterResume ?? ""))
          ? "ok"
          : String(sim.state.knowledgeAfterResume ?? "")
              .replace(/<[^>]+>/g, " ")
              .replace(/\s+/g, " ")
              .slice(0, 160)
      }`,
    ),
    check(
      "a pull request after resume is reviewed",
      resumedPull?.jobs.some(
        (job) => job.type === "review" && job.status === "done",
      ) === true &&
        sim.github.reviews.some(
          (review) => review.number === resumedPull.pull.number,
        ),
      `${String(resumedPull?.reply.outcome)} ${String(resumedPull?.reply.reason ?? "")} · ${resumedPull?.jobs.map((job) => `${job.type} ${job.status}`).join(", ") || "no job"}`,
    ),
    check(
      "a reinstall takes the same path: the new installation id, off, the notice, and resume works",
      reinstalled?.installation_id === Number(sim.state.newInstallationId) &&
        reinstalled.active === 0 &&
        Boolean(reinstalled.returned_at) &&
        String(sim.state.homeAfterReinstall ?? "").includes(NOTICE) &&
        sim.state.resumeAfterReinstall === 200,
      `installation ${String(reinstalled?.installation_id)} · active ${String(reinstalled?.active)} · resume ${String(sim.state.resumeAfterReinstall)}`,
    ),
    check(
      "a repository turned off by hand gets no notice when GitHub adds it back",
      sim.state.byHandRemove === 200 &&
        !byHand?.returned_at &&
        !String(sim.state.homeAfterByHand ?? "").includes(NOTICE),
      `remove ${String(sim.state.byHandRemove)} · returned ${byHand?.returned_at ? "set" : "empty"}`,
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
    {
      name: STEP.returned,
      async run(sim) {
        const reply = await sim.server.deliver(
          "installation_repositories",
          reposPayload(sim, "added"),
        );
        sim.state.marksAfterReturn = marks(sim);
        sim.state.homeAfterReturn = await (await dashboard()).page("/");
        return `${String(reply.body.reason)} · active ${String(marks(sim)?.active)}`;
      },
    },
    {
      name: STEP.returnedPull,
      async run(sim) {
        const round = await openAndDeliver(sim, "Add divide while off");
        sim.state.returnedPull = round;
        return `${String(round.reply.outcome)} ${String(round.reply.reason ?? "")}`;
      },
    },
    {
      name: STEP.resumeRefused,
      async run(sim) {
        const app = await dashboard();
        sim.state.noCookie = await app.resume({ cookie: false });
        sim.state.noHeader = await app.resume({ header: false });
        return `${String(sim.state.noCookie)} · ${String(sim.state.noHeader)}`;
      },
    },
    {
      name: STEP.resumed,
      async run(sim) {
        const setupBefore = appRows(
          sim,
          `SELECT id FROM jobs WHERE type = 'setup'`,
        ).length;
        const app = await dashboard();
        sim.state.resumeStatus = await app.resume();
        sim.state.marksAfterResume = marks(sim);
        sim.state.setupJobsAfterResume =
          appRows(sim, `SELECT id FROM jobs WHERE type = 'setup'`).length -
          setupBefore;
        sim.state.homeAfterResume = await app.page("/");
        sim.state.knowledgeAfterResume = await app.page(
          `/repos/${APP_REPO}/knowledge`,
        );
        return `${String(sim.state.resumeStatus)} · active ${String(marks(sim)?.active)}`;
      },
    },
    {
      name: STEP.resumedPull,
      async run(sim) {
        const round = await openAndDeliver(sim, "Add divide after resume");
        sim.state.resumedPull = round;
        return (
          round.jobs.map((job) => `${job.type} ${job.status}`).join(", ") ||
          "no job"
        );
      },
    },
    {
      name: STEP.reinstalled,
      async run(sim) {
        const oldId = sim.github.installation.id;
        await sim.server.deliver(
          "installation",
          installationPayload("deleted", oldId),
        );
        const newId = oldId + 1;
        (sim.github.installation as { id: number }).id = newId;
        sim.state.newInstallationId = newId;
        await sim.server.deliver("installation", {
          ...installationPayload("created", newId),
          repositories: [{ full_name: APP_REPO }],
        });
        sim.state.marksAfterReinstall = marks(sim);
        const app = await dashboard();
        sim.state.homeAfterReinstall = await app.page("/");
        sim.state.resumeAfterReinstall = await app.resume();
        return `installation ${newId} · resume ${String(sim.state.resumeAfterReinstall)}`;
      },
    },
    {
      name: STEP.byHand,
      async run(sim) {
        const app = await dashboard();
        sim.state.byHandRemove = await app.remove();
        await sim.server.deliver(
          "installation_repositories",
          reposPayload(sim, "removed"),
        );
        await sim.server.deliver(
          "installation_repositories",
          reposPayload(sim, "added"),
        );
        sim.state.marksAfterByHand = marks(sim);
        sim.state.homeAfterByHand = await app.page("/");
        return `remove ${String(sim.state.byHandRemove)} · returned ${marks(sim)?.returned_at ? "set" : "empty"}`;
      },
    },
  ],
  checks,
});
