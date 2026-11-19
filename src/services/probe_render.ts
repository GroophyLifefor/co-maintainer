/** The text `co-maintainer probe` prints: research, the init estimate with
 * an optional faster option, the review estimate, and the commands to run.
 * Colors are only used on a terminal that wants them. */
import { costReason } from "../ai/estimate.ts";
import type { ReviewCost } from "../ai/review_estimate.ts";
import type { ProbePlan } from "./probe.ts";
import type { InitOption, ProbeEstimate } from "./probe_estimate.ts";

export type RenderInput = {
  repo: string;
  plan: ProbePlan;
  estimate: ProbeEstimate;
  ai: string;
  commitWatch?: { app: "on" | "off"; branch: string | null };
  color: boolean;
};

/** Colors on a terminal, off with `NO_COLOR`, in CI and when piped. */
export function wantsColor(
  isTty: boolean,
  env: (name: string) => string | undefined,
): boolean {
  if (!isTty) return false;
  if (env("NO_COLOR") !== undefined && env("NO_COLOR") !== "") return false;
  if (env("CI") !== undefined && env("CI") !== "" && env("CI") !== "false") {
    return false;
  }
  return true;
}

type Paint = (text: string) => string;

function painter(color: boolean) {
  const code =
    (...codes: number[]): Paint =>
    (text) =>
      color ? `\x1b[${codes.join(";")}m${text}\x1b[0m` : text;
  return {
    bold: code(1),
    dim: code(2),
    head: code(1, 97),
    green: code(32),
    boldGreen: code(1, 32),
    cyan: code(36),
    boldCyan: code(1, 36),
    yellow: code(33),
    blue: code(94),
    boldBlue: code(1, 94),
  };
}

/** `1h 25m`, `25m`, `40s`. */
export function duration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function durationRange([low, high]: [number, number]): string {
  const a = duration(low);
  const b = duration(high);
  return a === b ? a : `${a}-${b}`;
}

/** Dollars with cents, or four places under ten cents. */
export function money(usd: number): string {
  return `$${usd >= 0.1 ? usd.toFixed(2) : usd.toFixed(4)}`;
}

const count = (value: number) => Math.round(value).toLocaleString("en-US");

function windowLabel(option: InitOption): string {
  const months = option.maxPrMonths
    ? `${option.maxPrMonths} months`
    : "all months";
  return option.commits > 0 ? `${months} · ${option.commits} commits` : months;
}

export function renderProbe(input: RenderInput): string {
  const p = painter(input.color);
  const { plan, estimate } = input;
  const { analysis } = plan;
  const lines: string[] = [];
  const out = (line = "") => lines.push(line);

  // research
  const months = analysis.maxPrMonths;
  const inWindow = estimate.recommended.pullRequests;
  out(p.head("research"));
  out(
    `  ${p.dim("PRs")} ${p.bold(String(analysis.report.pullRequests ?? 0))}` +
      (months
        ? ` ${p.dim("· in window")} ${p.bold(String(inWindow))} ${p.dim(
            `(updated in the last ${months} months)`,
          )}`
        : "") +
      ` ${p.dim(`· sampled ${analysis.report.sampledPullRequests ?? 0}`)}`,
  );
  out(
    `  ${p.dim("commits")} ${p.bold(String(analysis.report.commits ?? 0))} ${p.dim(
      "· useful",
    )} ${p.bold(String(analysis.report.usefulCommits ?? 0))}`,
  );
  out(
    `  ${p.dim(
      `windows: PR months=${months ?? "all"} · commits=${
        analysis.maxCommits ?? "all"
      } · diff lines=${analysis.maxPullRequestChangeLines ?? "all"}`,
    )}`,
  );
  for (const reason of analysis.reasons) out(`  - ${reason}`);

  // init estimate
  const reason = costReason(
    input.ai,
    estimate.pricesUnavailable,
    !estimate.modelsMissing,
  );
  const missing = (text: string) => p.yellow(text);
  const option = (
    mark: string,
    item: InitOption,
    note: string,
    costNote: string,
  ) => {
    out(`  ${mark}  ${p.blue(windowLabel(item))}${note ? `  ${note}` : ""}`);
    out(
      `    ${p.dim("time    ")}${p.bold(durationRange(item.seconds))}  ${bottleneckNote(
        item,
        p,
      )}`,
    );
    out(`    ${p.dim("github  ")}${githubLine(item, p)}`);
    out(
      `    ${p.dim("cost    ")}${
        item.ai.usd
          ? `${p.bold(`${money(item.ai.usd[0])}-${money(item.ai.usd[1])}`)} ${p.dim(
              `· ${costNote}`,
            )}`
          : missing(reason)
      }`,
    );
  };
  out();
  out(p.head("init estimate"));
  out();
  const rec = estimate.recommended;
  option(
    p.boldGreen("● recommended"),
    rec,
    "",
    `${count(rec.ai.extract)} extract + ${count(rec.ai.synth)} synth jobs`,
  );
  const fast = estimate.faster;
  if (fast) {
    out();
    const fits = fast.seconds[1] <= 30 * 60;
    option(
      `${p.boldCyan("◆ faster")}     `,
      fast,
      fits
        ? p.green("fits in 30 minutes")
        : p.yellow(`still about ${duration(fast.seconds[1])}`),
      `learns from ${fast.maxPrMonths} months of review history instead of ${
        rec.maxPrMonths ?? "all"
      }`,
    );
  }

  // review estimate
  out();
  const review = estimate.review;
  if (!review) {
    out(
      `${p.head("review estimate")}  ${p.dim(
        `not enough recent pull requests to estimate (${plan.reviewSample.length} found)`,
      )}`,
    );
  } else {
    out(
      `${p.head("review estimate")}  ${p.dim(
        `per pull request, from the ${review.sampled} newest, bots and drafts left out`,
      )}`,
    );
    if (review.median.usd === undefined) {
      out(`    ${missing(reason)}`);
    } else {
      out(`    ${p.dim("median  ")}${reviewLine(review.median, p)}`);
      out(`    ${p.dim("highest ")}${reviewLine(review.highest, p)}`);
    }
  }
  out();
  out(
    `  ${p.dim(
      `basis: ${
        rec.ai.basis === "history"
          ? "this repository's recorded jobs"
          : "the cm-dx-lab calibration"
      }, an estimate, not a bill`,
    )}`,
  );

  if (input.commitWatch) {
    const watch = input.commitWatch;
    out();
    out(
      `${p.head("commit watch")}   ${
        watch.app === "on" ? "✓ App (push event on)" : "○ App (push event off)"
      }   ${watch.branch ?? ""}`.trimEnd(),
    );
  }

  // commands
  out();
  out(p.head(fast ? "run one" : "run"));
  out(`  ${p.green("● recommended")}`);
  out(`       ${command(input.repo, rec, p)}`);
  if (fast) {
    out();
    out(`  ${p.cyan("◆ faster")}`);
    out(`       ${command(input.repo, fast, p)}`);
  }
  out();
  out(
    `  ${p.dim(
      `or run the recommended one now: co-maintainer probe ${input.repo} --run`,
    )}`,
  );
  out(`  ${p.dim("Probe only reads. It does not write guides.")}`);
  return lines.join("\n");
}

function bottleneckNote(
  item: InitOption,
  p: ReturnType<typeof painter>,
): string {
  if (item.bottleneck === "close") {
    return p.yellow("GitHub time and AI time are close");
  }
  if (item.bottleneck === "ai") return p.dim("AI time decides");
  return item.github.quotaWaitSeconds > 0
    ? p.yellow("the GitHub hourly limit decides")
    : p.dim("GitHub time decides");
}

function githubLine(item: InitOption, p: ReturnType<typeof painter>): string {
  const calls = p.bold(`${count(item.github.calls)} calls`);
  const quota = item.github.quota;
  if (!quota) return calls;
  if (item.github.quotaWaitSeconds > 0) {
    return `${calls} ${p.yellow(
      `· waits about ${duration(item.github.quotaWaitSeconds)} for the hourly limit of ${count(
        quota.limit,
      )}`,
    )}`;
  }
  if (item.github.calls > quota.remaining) {
    return `${calls} ${p.dim(
      `· stays under ${count(quota.limit)} per hour as it runs`,
    )}`;
  }
  return `${calls} ${p.dim(
    `· fits in this hour's quota (${count(quota.remaining)} left)`,
  )}`;
}

function reviewLine(cost: ReviewCost, p: ReturnType<typeof painter>): string {
  const summarized =
    cost.summarized > 0
      ? `, ${cost.summarized} ${cost.summarized === 1 ? "file" : "files"} summarized`
      : "";
  return `${p.bold(money(cost.usd ?? 0))} ${p.dim(
    `· ${count(cost.changedLines)} changed lines${summarized}`,
  )}`;
}

/** The whole command, the shared flags dim and the window flags bold, so
 * the part that differs between the options stands out. */
function command(
  repo: string,
  item: InitOption,
  p: ReturnType<typeof painter>,
): string {
  const windowFlag = (flag: string) =>
    flag.startsWith("--max-pr-months=") || flag.startsWith("--max-commits=");
  const base = ["co-maintainer", "init", repo]
    .concat(item.recommendation.filter((flag) => !windowFlag(flag)))
    .join(" ");
  const window = item.recommendation.filter(windowFlag).join(" ");
  return window ? `${p.dim(base)} ${p.boldBlue(window)}` : p.dim(base);
}

/** The same estimate as plain sentences, for the dashboard's Add repository
 * preview, so it says what the CLI says. */
export type EstimateSummaryOption = {
  label: string;
  time: string;
  github: string;
  cost: string;
  command: string;
};

export type EstimateSummary = {
  recommended: EstimateSummaryOption;
  faster?: EstimateSummaryOption & { fits: boolean };
  review: string;
  basis: string;
};

export function estimateSummary(
  repo: string,
  estimate: ProbeEstimate,
  ai: string,
): EstimateSummary {
  const p = painter(false);
  const reason = costReason(
    ai,
    estimate.pricesUnavailable,
    !estimate.modelsMissing,
  );
  const option = (item: InitOption, costNote: string) => ({
    label: windowLabel(item),
    time: `${durationRange(item.seconds)}, ${bottleneckNote(item, p)}`,
    github: githubLine(item, p),
    cost: item.ai.usd
      ? `${money(item.ai.usd[0])}-${money(item.ai.usd[1])} · ${costNote}`
      : reason,
    command: command(repo, item, p),
  });
  const rec = estimate.recommended;
  const fast = estimate.faster;
  const review = estimate.review;
  return {
    recommended: option(
      rec,
      `${count(rec.ai.extract)} extract + ${count(rec.ai.synth)} synth jobs`,
    ),
    ...(fast
      ? {
          faster: {
            ...option(
              fast,
              `learns from ${fast.maxPrMonths} months of review history instead of ${
                rec.maxPrMonths ?? "all"
              }`,
            ),
            fits: fast.seconds[1] <= 30 * 60,
          },
        }
      : {}),
    review: !review
      ? "not enough recent pull requests to estimate"
      : review.median.usd === undefined
        ? reason
        : `median ${reviewLine(review.median, p)}, highest ${reviewLine(
            review.highest,
            p,
          )}, per pull request from the ${review.sampled} newest, bots and drafts left out`,
    basis: `${
      rec.ai.basis === "history"
        ? "this repository's recorded jobs"
        : "the cm-dx-lab calibration"
    }, an estimate, not a bill`,
  };
}
