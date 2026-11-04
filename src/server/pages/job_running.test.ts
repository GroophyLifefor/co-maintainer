import { createApp } from "../app.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { writeUserConfig } from "../../config.ts";
import { activateRepo } from "../../store/repos.ts";
import { insertJob, setJobStatus } from "../../store/jobs.ts";
import {
  deleteEnv,
  getEnv,
  setEnv,
  tempDirSync,
} from "../../testing/runtime.ts";
import { test } from "node:test";

const PASSWORD = "job-running-pass";
const STAGES = [
  { name: "Read code", state: "done", detail: "112 files" },
  { name: "Read pull requests", state: "current", detail: "31 of 50", percent: 62 },
  { name: "Extract facts", state: "pending" },
];

async function jobPage(
  type: string,
  status: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const keys = ["CM_APP_DB", "CM_CONFIG_PATH", "CM_REPOS_DIR"];
  const original = keys.map((key) => getEnv(key));
  const dir = tempDirSync();
  setEnv("CM_APP_DB", `${dir}/app.db`);
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  setEnv("CM_REPOS_DIR", `${dir}/repos`);
  try {
    await openAppDb();
    await writeUserConfig({ auth: "gh", ai: "none" });
    activateRepo("acme/widgets", 9);
    insertJob({ id: "job-1", type, repo: "acme/widgets", args, prNumber: type === "review" ? 7 : undefined });
    setJobStatus("job-1", status);
    const app = createApp({ password: PASSWORD });
    const login = await app.fetch(
      new Request("http://localhost/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `password=${PASSWORD}&next=/`,
        redirect: "manual",
      }),
    );
    const token = (login.headers.get("set-cookie") ?? "").match(/^cm=([^;]+)/)?.[1];
    if (!token) throw new Error("no session cookie");
    return await (
      await app.fetch(
        new Request("http://localhost/activity/job-1", { headers: { cookie: `cm=${token}` } }),
      )
    ).text();
  } finally {
    await closeAppDb();
    keys.forEach((key, i) => {
      const value = original[i];
      if (value === undefined) deleteEnv(key);
      else setEnv(key, value);
    });
  }
}

test("the title reads kind · repository", async () => {
  const cases: [string, string][] = [
    ["init", "Init · widgets"],
    ["remake", "Sync · widgets"],
    ["review", "Review #7 · widgets"],
  ];
  for (const [type, title] of cases) {
    const html = await jobPage(type, "running", { stages: STAGES });
    if (!html.includes(`<h1>${title}</h1>`)) throw new Error(`${type}: no <h1>${title}</h1>`);
  }
});

test("the breadcrumb goes back to Activity and names the job", async () => {
  const html = await jobPage("init", "running", { stages: STAGES });
  if (!/<div class="crumb"><a href="\/activity">Activity<\/a><svg[^>]*><use href="#i-chevron-right"><\/use><\/svg><span>Set up repository<\/span><\/div>/.test(html)) {
    throw new Error("no Activity › Set up repository breadcrumb");
  }
});

test("a running job says when it started and how long is left", async () => {
  const html = await jobPage("init", "running", { stages: STAGES, estimateSeconds: [360, 360] });
  const lead = html.match(/<div class="d">([\s\S]*?)<\/div>/)?.[1] ?? "";
  if (!lead.includes("Started") || !lead.includes("about 6 min left")) {
    throw new Error(`lead lacks start and time left: ${lead}`);
  }
});

test("stages carry check, spinner and circle icons", async () => {
  const html = await jobPage("init", "running", { stages: STAGES });
  const icons = [...html.matchAll(/<li data-stage-state="(\w+)"><span class="ic[^"]*"><svg class="ic([^"]*)"[^>]*><use href="#i-([a-z-]+)">/g)].map(
    (m) => `${m[1]}:${m[3]}${m[2]!.includes("spin") ? ":spin" : ""}`,
  );
  if (icons.join(",") !== "done:check,current:loader:spin,pending:circle") {
    throw new Error(`stage icons: ${icons.join(",")}`);
  }
});

test("Stop after this step carries the square stop mark", async () => {
  const html = await jobPage("init", "running", { stages: STAGES });
  if (!/<button class="btn out" type="button" data-cancel="job-1"><svg[^>]*><use href="#i-square"><\/use><\/svg>Stop after this step<\/button>/.test(html)) {
    throw new Error("Stop after this step has no square mark");
  }
});
