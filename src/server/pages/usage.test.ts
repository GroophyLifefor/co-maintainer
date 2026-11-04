import { createApp } from "../app.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { writeUserConfig } from "../../config.ts";
import { activateRepo } from "../../store/repos.ts";
import { insertReview, setReviewStatus } from "../../store/reviews.ts";
import { insertJob } from "../../store/jobs.ts";
import {
  deleteEnv,
  getEnv,
  setEnv,
  tempDirSync,
} from "../../testing/runtime.ts";
import { test } from "node:test";

const PASSWORD = "usage-pass";

async function usage(path = "/usage"): Promise<string> {
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
    const review = (id: string, pr: number) =>
      insertReview({
        id,
        repo: "acme/widgets",
        prNumber: pr,
        jobId: `job-${id}`,
        headSha: "h",
        baseSha: "b",
        scope: "full",
        model: "m",
      });
    review("posted", 1);
    setReviewStatus("posted", "posted", { cost: 0.01, cost_status: "known", duration_ms: 7000 });
    review("not-posted", 2);
    setReviewStatus("not-posted", "not_posted", { cost: 0.01, cost_status: "known" });
    review("failed", 3);
    setReviewStatus("failed", "failed", { cost: 0.02, cost_status: "known" });
    insertJob({ id: "job-init", type: "init", repo: "acme/widgets" });
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
        new Request(`http://localhost${path}`, { headers: { cookie: `cm=${token}` } }),
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

function card(html: string, label: string): string {
  const at = html.indexOf(`<div class="top">${label}`);
  if (at < 0) throw new Error(`no stat card "${label}"`);
  const end = html.indexOf('<div class="stat">', at + 1);
  return html.slice(at, end < 0 ? undefined : end);
}

function kindRow(html: string, label: string): string[] {
  const row = html.match(new RegExp(`<tr><td>${label}</td>([\\s\\S]*?)</tr>`))?.[1];
  if (!row) throw new Error(`no By kind row "${label}"`);
  return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]!.trim());
}

test("the range is a 7d / 30d / 90d segmented control, not a dropdown", async () => {
  const html = await usage();
  if (html.includes('<select id="range"')) throw new Error("the range is still a dropdown");
  for (const range of ["7d", "30d", "90d"]) {
    if (!new RegExp(`<a[^>]*href="/usage\\?range=${range}"[^>]*>${range}</a>`).test(html)) {
      throw new Error(`no ${range} segment`);
    }
  }
  if (!/<a class="on" aria-current="page" href="\/usage\?range=30d">30d<\/a>/.test(html)) {
    throw new Error("30d is not the default segment");
  }
  const week = await usage("/usage?range=7d");
  if (!/<a class="on" aria-current="page" href="\/usage\?range=7d">7d<\/a>/.test(week)) {
    throw new Error("7d is not marked when chosen");
  }
});

test("four stat cards: Spent, Reviews, Findings, Avg. review", async () => {
  const html = await usage();
  if ((html.match(/<div class="stat">/g) ?? []).length !== 4) {
    throw new Error("want four stat cards");
  }
  // Spent is every kind of review: posted, not posted and failed.
  if (!/<div class="v">\$0\.04<\/div>/.test(card(html, "Spent"))) {
    throw new Error(`spent is not $0.04: ${card(html, "Spent").slice(0, 200)}`);
  }
  const reviews = card(html, "Reviews");
  if (!reviews.includes("1 failed attempt") || !reviews.includes("1 not posted")) {
    throw new Error(`reviews hint wrong: ${reviews.slice(0, 300)}`);
  }
  card(html, "Findings");
  if (!/<div class="v">7s<\/div>|<div class="v">7 s<\/div>/.test(card(html, "Avg. review"))) {
    throw new Error(`avg review wrong: ${card(html, "Avg. review").slice(0, 200)}`);
  }
});

test("By kind splits runs and cost, and says when a cost is not recorded", async () => {
  const html = await usage();
  const cases: [string, string, string][] = [
    ["init / sync", "1", "Not recorded"],
    ["Pull request reviews", "1", "$0.01"],
    ["Not posted reviews", "1", "$0.01"],
    ["Failed attempts", "1", "$0.02"],
    ["CLI reviews", "0", "$0.00"],
  ];
  for (const [label, runs, cost] of cases) {
    const cells = kindRow(html, label);
    if (cells[0] !== runs || cells[1] !== cost) {
      throw new Error(`${label}: ${JSON.stringify(cells)}`);
    }
  }
});

test("By kind and By model sit side by side", async () => {
  const html = await usage();
  const cols = html.match(/<div class="cols c11">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/)?.[0] ?? "";
  const at = html.indexOf('<div class="cols c11">');
  const block = html.slice(at, html.indexOf("Cost per day", at));
  if (at < 0 || !block.includes("By kind") || !block.includes("By model")) {
    throw new Error(`By kind and By model are not in one two-column row ${cols.length}`);
  }
});
