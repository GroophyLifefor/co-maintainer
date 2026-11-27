/** A customer upgrades from an older release, and moves the data folder.
 *
 * An older release left an app.db at an older schema. The new one must open
 * it, migrate it, keep what was in it, back it up first, and carry on
 * reviewing. The config file moves with the data: a server started from
 * another place, with its config.json copied, reviews the same way.
 *
 * The old database is made the way the product made it: the migrations the
 * older release knew, applied one after another, and a user_version that says
 * how many. Every check reads GitHub's reviews and app.db rows, never what the
 * model answered, so the flow passes with a real model too. */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AiRule } from "../fake_ai.ts";
import { check, defineFlow, type CheckResult, type Sim } from "../flow.ts";
import type { SimPull } from "../github.ts";
import { migrations } from "../../../store/migrations.ts";
import { APP_REPO, OPENED_MATH, openPull, serveRepo } from "./app.ts";
import { INIT_AI } from "./init.ts";

/** How many migrations the older release knew: five fewer than this one. */
const OLD_VERSION = migrations.length - 5;

const STEP = {
  served: "serve a repository with guides, and review a pull request",
  old: "app.db is replaced by one an older release left, at an older schema",
  upgraded: "the new release starts, backs up and migrates it",
  afterUpgrade: "a new pull request is reviewed after the upgrade",
  moved:
    "the config file and the data move to another place and the server starts from it",
  afterMove: "a pull request is reviewed from the new place",
};

const AI: AiRule[] = [
  ...INIT_AI,
  {
    name: "any review",
    job: "review_pull_request",
    prompt: /[\s\S]*/,
    reply: { findings: [] },
  },
];

const FILES = { "src/math.ts": OPENED_MATH };
const pullOf = (sim: Sim, key: string) => sim.state[key] as SimPull;

function botReviews(sim: Sim, pull: SimPull): number {
  return sim.github.reviews.filter(
    (review) =>
      review.repo === pull.repo &&
      review.number === pull.number &&
      review.user.type === "Bot",
  ).length;
}

const dbPath = () => process.env.CM_APP_DB as string;

function rows<T>(sql: string, ...params: (string | number)[]): T[] {
  const database = new DatabaseSync(dbPath(), { readOnly: true });
  try {
    return database.prepare(sql).all(...params) as T[];
  } finally {
    database.close();
  }
}

const roundOf = (jobs: { type: string; status: string }[]) =>
  jobs.map((job) => `${job.type} ${job.status}`).join(", ") || "no job";

const sidecars = ["", "-wal", "-shm"];
function removeDb(path: string): void {
  for (const suffix of sidecars) rmSync(path + suffix, { force: true });
}

/** An app.db as the release that knew `version` migrations left it, holding
 * the repository and one finished review job. */
function writeOldDb(
  path: string,
  version: number,
  repo: { installation_id: number | null; knowledge_built_at: string | null },
): void {
  removeDb(path);
  const database = new DatabaseSync(path);
  try {
    for (let index = 0; index < version; index++) {
      for (const statement of migrations[index]!) database.exec(statement);
    }
    database.exec(`PRAGMA user_version = ${version}`);
    database
      .prepare(
        `INSERT INTO repos (full_name, installation_id, active, auto_review, knowledge_built_at, created_at)
         VALUES (?, ?, 1, 1, ?, ?)`,
      )
      .run(
        APP_REPO,
        repo.installation_id,
        repo.knowledge_built_at,
        "2026-01-01T00:00:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO jobs (id, type, repo, pr_number, status, args, created_at, finished_at)
         VALUES ('old-job-1', 'review', ?, 1, 'done', '{}', ?, ?)`,
      )
      .run(APP_REPO, "2026-01-02T00:00:00.000Z", "2026-01-02T00:01:00.000Z");
  } finally {
    database.close();
  }
}

export default defineFlow({
  name: "customer-upgrade",
  description:
    "an older release's app.db is migrated and backed up and reviews carry on, and a server started from a moved config file and data folder reviews the same way",
  ai: AI,
  skipInherited: {
    "cost recorded for every AI call":
      "app.db is replaced on purpose, so the cost rows of the calls made before are gone",
  },
  steps: [
    {
      name: STEP.served,
      async run(sim) {
        await serveRepo(sim);
        const first = await openPull(sim, {
          title: "First change",
          files: FILES,
        });
        sim.state.a = first.pull;
        return `#${first.pull.number} · ${roundOf(first.jobs)}`;
      },
    },
    {
      name: STEP.old,
      async run(sim) {
        const [repo] = rows<{
          installation_id: number | null;
          knowledge_built_at: string | null;
        }>("SELECT installation_id, knowledge_built_at FROM repos");
        await sim.server.stop();
        writeOldDb(dbPath(), OLD_VERSION, repo!);
        const version = new DatabaseSync(dbPath(), { readOnly: true });
        try {
          sim.state.versionBefore = (
            version.prepare("PRAGMA user_version").get() as {
              user_version: number;
            }
          ).user_version;
        } finally {
          version.close();
        }
        return `app.db at migration ${String(sim.state.versionBefore)} of ${migrations.length}`;
      },
    },
    {
      name: STEP.upgraded,
      async run(sim) {
        await sim.server.start();
        const database = new DatabaseSync(dbPath(), { readOnly: true });
        try {
          sim.state.versionAfter = (
            database.prepare("PRAGMA user_version").get() as {
              user_version: number;
            }
          ).user_version;
        } finally {
          database.close();
        }
        const { backupPaths } = await import("../../../store/app_db.ts");
        // The backup is of the database as it was before the migration: at
        // the old schema version, holding the old job.
        const backupDb = `${backupPaths().root}/previous/app.db`;
        let backupVersion = -1;
        let backupHasOldJob = false;
        if (existsSync(backupDb)) {
          const backup = new DatabaseSync(backupDb, { readOnly: true });
          try {
            backupVersion = (
              backup.prepare("PRAGMA user_version").get() as {
                user_version: number;
              }
            ).user_version;
            backupHasOldJob =
              (
                backup
                  .prepare(
                    "SELECT COUNT(*) AS n FROM jobs WHERE id = 'old-job-1'",
                  )
                  .get() as { n: number }
              ).n === 1;
          } finally {
            backup.close();
          }
        }
        sim.state.backupMade = backupVersion === OLD_VERSION && backupHasOldJob;
        sim.state.oldJob = rows<{ n: number }>(
          "SELECT COUNT(*) AS n FROM jobs WHERE id = 'old-job-1' AND status = 'done'",
        )[0]!.n;
        sim.state.repoKept = rows<{ n: number }>(
          "SELECT COUNT(*) AS n FROM repos WHERE full_name = ? AND active = 1 AND auto_review = 1 AND knowledge_built_at IS NOT NULL",
          APP_REPO,
        )[0]!.n;
        return `migrated ${String(sim.state.versionBefore)} -> ${String(sim.state.versionAfter)} · backup ${sim.state.backupMade ? "made" : "missing"} · old job ${String(sim.state.oldJob)} · repository ${String(sim.state.repoKept)}`;
      },
    },
    {
      name: STEP.afterUpgrade,
      async run(sim) {
        const second = await openPull(sim, {
          title: "Second change",
          files: FILES,
        });
        sim.state.b = second.pull;
        return `#${second.pull.number} · ${roundOf(second.jobs)}`;
      },
    },
    {
      name: STEP.moved,
      async run(sim) {
        await sim.server.stop();
        const from = dbPath();
        const toDir = join(dirname(from), "volume-b");
        mkdirSync(toDir, { recursive: true });
        for (const suffix of sidecars) {
          if (existsSync(from + suffix)) {
            copyFileSync(from + suffix, join(toDir, `app.db${suffix}`));
          }
        }
        const configFrom = process.env.CM_CONFIG_PATH as string;
        copyFileSync(configFrom, join(toDir, "config.json"));
        removeDb(from);
        rmSync(configFrom, { force: true });
        process.env.CM_APP_DB = join(toDir, "app.db");
        process.env.CM_CONFIG_PATH = join(toDir, "config.json");
        sim.state.originalGone = !existsSync(configFrom) && !existsSync(from);
        // The server starts the way `serve` starts, from the new paths.
        await sim.server.start();
        const { readConfig } = await import("../../../config.ts");
        sim.state.configFound = Boolean(readConfig().githubWebhookSecret);
        return `config.json and app.db moved to ${toDir} · webhook secret ${sim.state.configFound ? "found" : "missing"}`;
      },
    },
    {
      name: STEP.afterMove,
      async run(sim) {
        const third = await openPull(sim, {
          title: "Third change",
          files: FILES,
        });
        sim.state.c = third.pull;
        return `#${third.pull.number} · ${roundOf(third.jobs)}`;
      },
    },
  ],
  checks(sim): CheckResult[] {
    const reviews = (key: string) => botReviews(sim, pullOf(sim, key));
    return [
      check(
        "an app.db from an older release is backed up first, migrated to the current schema, and keeps its repository and job history",
        sim.state.versionBefore === OLD_VERSION &&
          sim.state.versionAfter === migrations.length &&
          sim.state.backupMade === true &&
          sim.state.oldJob === 1 &&
          sim.state.repoKept === 1,
        `migration ${String(sim.state.versionBefore)} -> ${String(sim.state.versionAfter)} · backup of the old schema ${String(sim.state.backupMade)} · old job ${String(sim.state.oldJob)} · repository ${String(sim.state.repoKept)}`,
      ),
      check(
        "reviews carry on after the upgrade: a new pull request is reviewed once",
        reviews("b") === 1,
        `second pull request: ${reviews("b")} reviews`,
      ),
      check(
        "a server started from a moved config file and data folder reads its settings and reviews once",
        sim.state.configFound === true &&
          reviews("c") === 1 &&
          reviews("a") === 1 &&
          reviews("b") === 1,
        `config ${String(sim.state.configFound)} · reviews: a ${reviews("a")}, b ${reviews("b")}, c ${reviews("c")}`,
      ),
    ];
  },
});
