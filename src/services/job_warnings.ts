/** Problems a job logged on its way to finishing. A review can post fine and
 * still fail to update its GitHub check run, for example when the GitHub App
 * lacks the Checks permission. The job page shows each one in a banner that
 * says what is wrong and how to fix it, and the Activity row gets a mark. */
import { getAppDb } from "../store/app_db.ts";
import { RATE_LIMIT_WAIT_LOG_TYPE } from "./rate_limit.ts";
import type { JobLogRow } from "../store/rows.ts";

export type JobWarning = {
  /** What went wrong, in a sentence. */
  problem: string;
  /** How to fix it, in a sentence. */
  fix: string;
  /** Where the fix is made, when the dashboard has a page for it. */
  fixHref?: string;
  /** The log line it came from. */
  line: string;
};

const DENIED = /\b40[34]\b|not found|resource not accessible|forbidden/i;

/** Known problems that older builds logged as plain info lines, and that
 * newer ones log as warnings. Matched by text, so both are caught. */
const KNOWN: {
  match: RegExp;
  warning: (message: string) => Omit<JobWarning, "line">;
}[] = [
  {
    match: /^GitHub Check Run (update failed|unavailable)/,
    warning: (message) =>
      DENIED.test(message)
        ? {
            problem:
              "GitHub refused to update the check run on the pull request. The GitHub App does not have the Checks permission.",
            fix: "In the GitHub App settings on GitHub, set Checks to Read and write, then accept the new permission on each installation.",
            fixHref: "/settings/github",
          }
        : {
            problem:
              "The GitHub check run on the pull request was not updated.",
            fix: "Check that the GitHub App has Checks set to Read and write and that GitHub was reachable, then run the review again.",
            fixHref: "/settings/github",
          },
  },
  {
    match: /^could not (post|update) the failure note/,
    warning: () => ({
      problem: "Could not leave the failure note on the pull request.",
      fix: "Give the GitHub App Pull requests or Issues set to Read and write.",
      fixHref: "/settings/github",
    }),
  },
  {
    match: /^could not react to the review request/,
    warning: () => ({
      problem: "Could not react to the comment that asked for the review.",
      fix: "Give the GitHub App Issues set to Read and write.",
      fixHref: "/settings/github",
    }),
  },
  {
    match: /^could not read the (earlier comments|review threads)/,
    warning: () => ({
      problem:
        "Could not read the earlier review comments, so this review may repeat one.",
      fix: "Give the GitHub App Pull requests set to Read.",
      fixHref: "/settings/github",
    }),
  },
];

/** The log lines worth a look among `logs`: a warning or an error, or a
 * known problem logged as info. A rate limit wait has its own notice and the
 * final status line is not a problem. Each problem appears once. */
export function jobWarnings(logs: JobLogRow[]): JobWarning[] {
  const found = new Map<string, JobWarning>();
  for (const line of logs) {
    const message = line.message.trim();
    const known = KNOWN.find((entry) => entry.match.test(message));
    if (known) {
      const warning = known.warning(message);
      if (!found.has(warning.problem)) {
        found.set(warning.problem, { ...warning, line: message });
      }
      continue;
    }
    if (line.level !== "warn" && line.level !== "error") continue;
    if (message.includes(`"type":"${RATE_LIMIT_WAIT_LOG_TYPE}"`)) continue;
    const problem = `The job logged ${line.level === "error" ? "an error" : "a warning"}: ${message.split("\n")[0]!.slice(0, 200)}`;
    if (!found.has(problem)) {
      found.set(problem, {
        problem,
        fix: "Read the log below for the details.",
        line: message,
      });
    }
  }
  return [...found.values()];
}

/** The first problem of each finished job among `jobIds`, for the mark on
 * its Activity row. One query for the whole page. */
export function warningsForJobs(jobIds: string[]): Map<string, JobWarning> {
  const out = new Map<string, JobWarning>();
  if (jobIds.length === 0) return out;
  const rows = getAppDb()
    .prepare<JobLogRow>(
      `SELECT l.* FROM job_logs l JOIN jobs j ON j.id = l.job_id
       WHERE l.job_id IN (${jobIds.map(() => "?").join(", ")})
         AND j.status = 'done'
         AND (l.level IN ('warn', 'error')
           OR l.message LIKE 'GitHub Check Run %'
           OR l.message LIKE 'could not %')
       ORDER BY l.job_id, l.seq`,
    )
    .all(...jobIds);
  const byJob = new Map<string, JobLogRow[]>();
  for (const row of rows) {
    byJob.set(row.job_id, [...(byJob.get(row.job_id) ?? []), row]);
  }
  for (const [jobId, lines] of byJob) {
    const first = jobWarnings(lines)[0];
    if (first) out.set(jobId, first);
  }
  return out;
}
