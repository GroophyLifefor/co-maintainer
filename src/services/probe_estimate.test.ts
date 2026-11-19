/** The probe estimate counts what `init` reads (the PR window, not every
 * pull request), adds the GitHub calls and the hourly quota, offers a faster
 * window when the run is over 30 minutes, and prints all of it with colors
 * only on a terminal. */
import { test } from "node:test";
import { estimateGithub } from "../ai/estimate.ts";
import { isolateTestFile } from "../testing/locations.ts";
import {
  type ProbePlan,
  pullRequestsInWindow,
  reviewable,
  sampleReviews,
} from "./probe.ts";
import type { GitHubClient, Json } from "../types.ts";
import { estimateProbe, FASTER_TARGET_SECONDS } from "./probe_estimate.ts";
import {
  duration,
  estimateSummary,
  money,
  renderProbe,
  wantsColor,
} from "./probe_render.ts";

isolateTestFile();

const NOW = Date.parse("2026-11-19T12:00:00Z");
const DAY = 24 * 60 * 60 * 1_000;

/** `total` pull requests, one every `everyDays` days back from now. */
function updatedDates(total: number, everyDays: number): string[] {
  return Array.from({ length: total }, (_, index) =>
    new Date(Date.now() - index * everyDays * DAY).toISOString(),
  );
}

function bigPlan(overrides: Partial<ProbePlan> = {}): ProbePlan {
  const recommendation = [
    "--include-codebase",
    "--include-pull-requests",
    "--include-pull-request-changes",
    "--include-commit-history",
    "--include-how-repo-works",
    "--max-pull-request-change-lines=900",
    "--max-pr-months=24",
    "--max-commits=3200",
  ];
  return {
    analysis: {
      includePullRequests: true,
      includePullRequestChanges: true,
      includeCommitHistory: true,
      maxPrMonths: 24,
      maxCommits: 3200,
      maxPullRequestChangeLines: 900,
      reasons: [],
      report: {
        pullRequests: 6000,
        sampledPullRequests: 72,
        commits: 16000,
        usefulCommits: 12700,
      },
    },
    recommendation,
    command: ["co-maintainer", "init", "acme/big", ...recommendation].join(" "),
    report: { repo: "acme/big" },
    // 6000 pull requests, one every 9 hours: about 1950 in 24 months.
    pullUpdatedAt: updatedDates(6000, 0.375),
    changeShare: 0.9,
    reviewSample: [],
    github: {
      calls: 300,
      secondsPerCall: 0.3,
      quota: {
        limit: 5000,
        remaining: 4800,
        resetAt: Date.now() + 40 * 60_000,
      },
    },
    ...overrides,
  };
}

const OPTIONS = {
  repo: "acme/big",
  ai: "none",
  ghConcurrent: 1,
  aiConcurrent: 3,
};

test("probe estimate: the window counts what init reads, not every pull request", () => {
  const dates = updatedDates(100, 30); // one a month for 100 months
  const inWindow = pullRequestsInWindow(dates, 24);
  if (inWindow < 23 || inWindow > 25) throw new Error(`24 months: ${inWindow}`);
  if (pullRequestsInWindow(dates, undefined) !== 100) {
    throw new Error("no window is every pull request");
  }
});

test("probe estimate: bots, drafts and empty diffs are not reviewed", () => {
  const base = {
    additions: 10,
    deletions: 2,
    user: { login: "dev", type: "User" },
  };
  if (!reviewable(base)) throw new Error("a person's PR is reviewed");
  if (reviewable({ ...base, user: { login: "renovate[bot]", type: "User" } })) {
    throw new Error("a [bot] login is skipped");
  }
  if (reviewable({ ...base, user: { login: "x", type: "Bot" } })) {
    throw new Error("a Bot type is skipped");
  }
  if (reviewable({ ...base, draft: true }))
    throw new Error("a draft is skipped");
  if (reviewable({ ...base, additions: 0, deletions: 0 })) {
    throw new Error("an empty diff is skipped");
  }
});

test("probe estimate: the review sample is the 10 newest reviewable pull requests", async () => {
  // 30 pull requests, newest first: every 4th is a bot's, every 5th a draft,
  // and #19 has no changes, so the next one is read in its place.
  const pulls: Json[] = Array.from({ length: 30 }, (_, index) => {
    const number = 30 - index;
    return {
      number,
      updated_at: new Date(Date.now() - index * DAY).toISOString(),
      draft: number % 5 === 0,
      user:
        number % 4 === 0
          ? { login: "renovate[bot]", type: "Bot" }
          : { login: "dev", type: "User" },
    };
  });
  const read: number[] = [];
  const client: GitHubClient = {
    request: async () => {
      throw new Error("not used");
    },
    pages: async <T>(endpoint: string): Promise<T[]> => {
      const number = Number(endpoint.match(/pulls\/(\d+)\/files/)?.[1]);
      read.push(number);
      const changes = number === 19 ? 0 : number;
      return [{ changes, patch: "x".repeat(changes) }] as T[];
    },
  };
  const sample = await sampleReviews(client, "acme/big", pulls, 3, () => {});
  const want = pulls
    .map((pull) => Number(pull.number))
    .filter((number) => number % 4 !== 0 && number % 5 !== 0 && number !== 19)
    .slice(0, 10);
  const got = sample.map((pull) => pull.number);
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`sample ${got} should be ${want}`);
  }
  if (!read.includes(19)) throw new Error("the empty one was read and skipped");
  if (read.some((number) => number % 4 === 0 || number % 5 === 0)) {
    throw new Error(`read a bot's or a draft's files: ${read}`);
  }
  if (sample[0].changedLines !== want[0]) {
    throw new Error("changed lines come from the files");
  }
});

test("probe estimate: GitHub calls past the quota wait for the reset", () => {
  const quota = { limit: 5000, remaining: 100, resetAt: NOW + 30 * 60_000 };
  const fits = estimateGithub({
    pullRequests: 10,
    includeChanges: true,
    changeShare: 1,
    includeCodebase: false,
    commits: 0,
    ghConcurrent: 1,
    secondsPerCall: 0.1,
    quota,
    now: NOW,
  });
  // metadata + 2 listing pages + 10 x 5 calls
  if (fits.calls !== 53) throw new Error(`calls: ${fits.calls}`);
  if (fits.quotaWaitSeconds !== 0) throw new Error("53 calls fit in 100");
  const over = estimateGithub({
    pullRequests: 1000,
    includeChanges: true,
    changeShare: 1,
    includeCodebase: true,
    commits: 0,
    ghConcurrent: 1,
    secondsPerCall: 0.1,
    quota,
    now: NOW,
  });
  // The calls cannot finish before the reset, so the rest of that is waiting.
  if (over.quotaWaitSeconds !== 30 * 60 - over.callSeconds) {
    throw new Error(`one reset: ${over.quotaWaitSeconds}`);
  }
  const twoHours = estimateGithub({
    pullRequests: 2000,
    includeChanges: true,
    changeShare: 1,
    includeCodebase: false,
    commits: 0,
    ghConcurrent: 1,
    secondsPerCall: 0.1,
    quota,
    now: NOW,
  });
  if (twoHours.quotaWaitSeconds !== 30 * 60 + 3600 - twoHours.callSeconds) {
    throw new Error(`reset plus an hour: ${twoHours.quotaWaitSeconds}`);
  }
  // Calls slow enough to outlast the reset never wait for it.
  const slow = estimateGithub({
    pullRequests: 1000,
    includeChanges: true,
    changeShare: 1,
    includeCodebase: false,
    commits: 0,
    ghConcurrent: 1,
    secondsPerCall: 1,
    quota,
    now: NOW,
  });
  if (slow.quotaWaitSeconds !== 0) {
    throw new Error(`slow calls waited: ${slow.quotaWaitSeconds}`);
  }
});

test("probe estimate: an empty PR window still costs the listing page", () => {
  const empty = estimateGithub({
    includePullRequests: true,
    pullRequests: 0,
    includeChanges: true,
    changeShare: 1,
    includeCodebase: false,
    commits: 0,
    ghConcurrent: 1,
    secondsPerCall: 0.1,
  });
  // metadata + the one listing page that shows the window is empty
  if (empty.calls !== 2) throw new Error(`calls: ${empty.calls}`);
  const off = estimateGithub({
    includePullRequests: false,
    pullRequests: 0,
    includeChanges: false,
    changeShare: 1,
    includeCodebase: false,
    commits: 0,
    ghConcurrent: 1,
    secondsPerCall: 0.1,
  });
  if (off.calls !== 1) throw new Error(`off calls: ${off.calls}`);
});

test("probe estimate: a run over 30 minutes gets a shorter, faster window", async () => {
  const estimate = await estimateProbe(bigPlan(), OPTIONS);
  const { recommended, faster } = estimate;
  if (recommended.pullRequests > 2000 || recommended.pullRequests < 1900) {
    throw new Error(`window: ${recommended.pullRequests}`);
  }
  if (!(recommended.seconds[1] > FASTER_TARGET_SECONDS)) {
    throw new Error(`recommended: ${recommended.seconds}`);
  }
  if (!faster) throw new Error("expected a faster option");
  if (!(faster.seconds[1] < recommended.seconds[1])) {
    throw new Error(`faster: ${faster.seconds} vs ${recommended.seconds}`);
  }
  if (!faster.maxPrMonths || faster.maxPrMonths >= 24) {
    throw new Error(`faster months: ${faster.maxPrMonths}`);
  }
  if (!faster.maxCommits || faster.maxCommits >= 3200) {
    throw new Error(`faster commits: ${faster.maxCommits}`);
  }
  if (
    !faster.command.includes(`--max-pr-months=${faster.maxPrMonths}`) ||
    faster.command.includes("--max-pr-months=24")
  ) {
    throw new Error(`faster command: ${faster.command}`);
  }
  if (!estimate.modelsMissing) throw new Error("no models were given");
});

test("probe estimate: the first window that fits in 30 minutes wins", async () => {
  // With 4 GitHub calls at once a 6 month window fits, the 12 month one
  // does not.
  const plan = bigPlan();
  const estimate = await estimateProbe(plan, { ...OPTIONS, ghConcurrent: 4 });
  const faster = estimate.faster;
  if (!faster) throw new Error("expected a faster option");
  if (!(faster.seconds[1] <= FASTER_TARGET_SECONDS)) {
    throw new Error(`faster: ${faster.seconds} (${faster.maxPrMonths} months)`);
  }
});

test("probe estimate: a run under 30 minutes has no faster option", async () => {
  const plan = bigPlan({ pullUpdatedAt: updatedDates(40, 7) });
  const estimate = await estimateProbe(plan, OPTIONS);
  if (estimate.faster) throw new Error("no faster option for a short run");
});

test("probe output: colors only when asked, commands whole and copyable", async () => {
  const plan = bigPlan();
  const estimate = await estimateProbe(plan, OPTIONS);
  const input = { repo: "acme/big", plan, estimate, ai: "none" };
  const plain = renderProbe({ ...input, color: false });
  if (plain.includes("\x1b[")) throw new Error("plain output has escapes");
  const lines = plain.split("\n");
  const commands = lines.filter((line) =>
    line.trim().startsWith("co-maintainer init acme/big"),
  );
  if (commands.length !== 2) throw new Error(`commands:\n${plain}`);
  for (const line of commands) {
    if (!line.startsWith("       co-maintainer")) {
      throw new Error(`a command is indented 7 spaces: "${line}"`);
    }
  }
  if (!plain.includes("--low-model=<id> --high-model=<id>")) {
    throw new Error("the model warning is missing");
  }
  if (!plain.includes("◆ faster"))
    throw new Error("the faster option is missing");
  const colored = renderProbe({ ...input, color: true });
  if (!colored.includes("\x1b["))
    throw new Error("colored output has no escapes");
  // The dashboard gets the same numbers as plain sentences.
  const summary = estimateSummary("acme/big", estimate, "none");
  if (!summary.faster || summary.recommended.command.includes("\x1b[")) {
    throw new Error(`summary: ${JSON.stringify(summary)}`);
  }
});

test("probe output: color rules follow the terminal, NO_COLOR and CI", () => {
  const env = (values: Record<string, string>) => (name: string) =>
    values[name];
  if (!wantsColor(true, env({}))) throw new Error("a terminal gets colors");
  if (wantsColor(false, env({}))) throw new Error("a pipe gets none");
  if (wantsColor(true, env({ NO_COLOR: "1" }))) throw new Error("NO_COLOR");
  if (wantsColor(true, env({ CI: "true" }))) throw new Error("CI");
});

test("probe output: durations and dollars read naturally", () => {
  const cases: [string, string][] = [
    [duration(40), "40s"],
    [duration(25 * 60), "25m"],
    [duration(85 * 60), "1h 25m"],
    [duration(120 * 60), "2h"],
    [money(0.0098), "$0.0098"],
    [money(0.64), "$0.64"],
  ];
  for (const [got, want] of cases) {
    if (got !== want) throw new Error(`${got} should be ${want}`);
  }
});
