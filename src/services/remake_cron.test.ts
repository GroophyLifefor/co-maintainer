import { test } from "node:test";
import { closeAppDb, openAppDb } from "../store/app_db.ts";
import { activateRepo, markKnowledgeBuilt } from "../store/repos.ts";
import { getRunningJobByKey, listJobs, setJobStatus } from "../store/jobs.ts";
import { writeRepoConfig, writeUserConfig } from "../config.ts";
import { deleteEnv, getEnv, setEnv, tempDirSync } from "../testing/runtime.ts";
import { createRemakeCronTicker, parseRemakeCron } from "./remake_cron.ts";

async function withTempEnv(fn: () => Promise<void>): Promise<void> {
  const originalDb = getEnv("CM_APP_DB");
  const originalConfig = getEnv("CM_CONFIG_PATH");
  setEnv("CM_APP_DB", `${tempDirSync()}/app.db`);
  setEnv("CM_CONFIG_PATH", `${tempDirSync()}/config.json`);
  try {
    await openAppDb();
    await writeUserConfig({ auth: "gh", ai: "none" });
    await fn();
  } finally {
    await closeAppDb();
    if (originalDb === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", originalDb);
    if (originalConfig === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", originalConfig);
  }
}

async function scheduledRepo(name: string, cron: string | undefined) {
  activateRepo(name, undefined);
  markKnowledgeBuilt(name, "sha");
  if (cron) await writeRepoConfig(name, { remakeCron: cron });
}

const remakes = () => listJobs({}).filter((job) => job.type === "remake");

test("a matching minute queues one remake and the same minute is not repeated", async () => {
  await withTempEnv(async () => {
    await scheduledRepo("acme/widgets", "30 4 * * *");
    const tick = createRemakeCronTicker();
    const first = tick(new Date("2026-09-21T04:30:05Z"));
    if (first.join() !== "acme/widgets") throw new Error(`got ${first}`);
    if (tick(new Date("2026-09-21T04:30:50Z")).length !== 0) {
      throw new Error("the same minute fired twice");
    }
    if (remakes().length !== 1) throw new Error("expected one remake job");
  });
});

test("a minute that does not match queues nothing", async () => {
  await withTempEnv(async () => {
    await scheduledRepo("acme/widgets", "30 4 * * *");
    const tick = createRemakeCronTicker();
    if (tick(new Date("2026-09-21T04:31:00Z")).length !== 0) {
      throw new Error("fired outside the schedule");
    }
  });
});

test("a repo with no schedule, no built knowledge or a bad schedule is skipped", async () => {
  await withTempEnv(async () => {
    await scheduledRepo("acme/plain", undefined);
    await scheduledRepo("acme/bad", "not a cron");
    await scheduledRepo("acme/everyminute", "* * * * *");
    activateRepo("acme/fresh", undefined);
    await writeRepoConfig("acme/fresh", { remakeCron: "30 4 * * *" });
    const tick = createRemakeCronTicker();
    if (tick(new Date("2026-09-21T04:30:00Z")).length !== 0) {
      throw new Error("a repo that should be skipped was queued");
    }
  });
});

test("a repo that already has a queued or running setup job is not queued again", async () => {
  await withTempEnv(async () => {
    await scheduledRepo("acme/widgets", "30 4 * * *");
    const tick = createRemakeCronTicker();
    tick(new Date("2026-09-21T04:30:00Z"));
    if (tick(new Date("2026-09-22T04:30:00Z")).length !== 0) {
      throw new Error("queued on top of a queued job");
    }
    const [job] = remakes();
    setJobStatus(job.id, "running", {});
    if (!getRunningJobByKey("setup:acme/widgets")) {
      throw new Error("the job did not move to running");
    }
    if (tick(new Date("2026-09-23T04:30:00Z")).length !== 0) {
      throw new Error("queued on top of a running job");
    }
    if (remakes().length !== 1) throw new Error("expected a single job");
  });
});

test("a remake schedule may fire at most once an hour", () => {
  parseRemakeCron("0 */6 * * *");
  for (const bad of ["* * * * *", "*/30 * * * *", "0,30 * * * *"]) {
    let threw = false;
    try {
      parseRemakeCron(bad);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`accepted ${bad}`);
  }
});
