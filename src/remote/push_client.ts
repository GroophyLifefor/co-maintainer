/** `co-maintainer review --remote --range=<before>..<after>`: commit watch
 * from CI.
 *
 * The step sends the push's diff and waits for the server's review. What it
 * reports and how it exits:
 * - findings are warnings, and the step stays green: the push is already in,
 *   so there is nothing to block.
 * - a review still running after `--timeout-minutes` (default 10) leaves a
 *   notice and stays green. The server finishes the review on its own.
 * - a push merged into a newer push's review leaves a notice and stays green.
 * - a repository that is not initialized is red, unless the GitHub App gave
 *   the commit a skipped check run: then it is a notice.
 * - a server that cannot be reached or rejects the token is red. */
import { VERSION } from "../version.ts";
import type { ReviewCliArgs } from "../cli/review_args.ts";
import { exitWith } from "../cli/error.ts";
import {
  formatHumanReview,
  humanFindingsFromJson,
  type JsonReviewFinding,
} from "../cli/review_result.ts";
import {
  baseUrl,
  die,
  handshakeFailure,
  readApiError,
  remoteFetch,
  remoteFromEnv,
} from "./http.ts";
import { notInitializedError } from "../review/not_initialized.ts";
import { readConfig } from "../config.ts";
import { stripControlChars } from "../util/sanitize.ts";
import { runCommand } from "../pr/checkout.ts";
import {
  assertGitQuiet,
  currentBranch,
  detectRemoteRepo,
  gitRoot,
} from "../local/git_ops.ts";
import { buildLocalRevision } from "../local/git_revision.ts";
import { withCliLogsToStderr } from "../util/log.ts";
import {
  emitGithubOutput,
  escapeData,
  neutralizeCommands,
} from "../cli/review_github.ts";
import { setCliInteractive } from "../cli/args.ts";
import {
  MIN_SERVER_SCHEMA,
  REMOTE_CLI_UPGRADE_COMMAND,
  REMOTE_SCHEMA_VERSION,
} from "./schema.ts";

export const DEFAULT_PUSH_TIMEOUT_MINUTES = 10;

type Cli = ReviewCliArgs & { mode: "remote" };

const ZERO = /^0+$/;

/** A notice the step shows and that never fails it. */
function notice(cli: Cli, message: string): void {
  if (cli.json) {
    console.log(
      JSON.stringify({ schemaVersion: 1, ok: true, mode: "push", message }),
    );
  } else if (cli.output === "github") {
    console.log(`::notice title=co-maintainer::${escapeData(message)}`);
  } else {
    console.log(message);
  }
}

async function git(root: string, args: string[]) {
  return await runCommand("git", args, root);
}

async function resolveCommit(
  root: string,
  rev: string,
): Promise<string | undefined> {
  const result = await git(root, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${rev}^{commit}`,
  ]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** `rev` as a full sha, fetching it from the remote when the checkout does
 * not have it (a shallow CI checkout usually holds only `after`). */
async function ensureCommit(
  root: string,
  remote: string,
  rev: string,
): Promise<string | undefined> {
  const local = await resolveCommit(root, rev);
  if (local) return local;
  await git(root, ["fetch", "--quiet", "--no-tags", remote, rev]);
  return await resolveCommit(root, rev);
}

/** Where the diff starts. `before` itself after a normal push. After a
 * force-push `before` is no longer an ancestor, so the commits since the
 * merge base. When `before` cannot be fetched at all, the last commit, with
 * a warning. */
async function diffBase(
  root: string,
  remote: string,
  before: string,
  after: string,
): Promise<string> {
  const have = await ensureCommit(root, remote, before);
  if (have) {
    let base = await git(root, ["merge-base", have, after]);
    if (base.code !== 0) {
      // A shallow checkout can hold both commits and still not their history.
      await git(root, ["fetch", "--quiet", "--no-tags", "--unshallow", remote]);
      base = await git(root, ["merge-base", have, after]);
    }
    if (base.code === 0 && base.stdout.trim()) return base.stdout.trim();
  }
  console.error(
    `Warning: could not fetch ${before.slice(0, 7)}, so only the last commit of this push is reviewed.`,
  );
  // `after^` is no refspec git can fetch, so a depth-one checkout is deepened
  // by one commit to bring the parent in.
  let parent = await resolveCommit(root, `${after}^`);
  if (!parent) {
    await git(root, ["fetch", "--quiet", "--no-tags", "--deepen=1", remote]);
    parent = await resolveCommit(root, `${after}^`);
  }
  if (!parent) {
    die(
      "push_base_missing",
      "Could not find the commit this push starts from.",
    );
  }
  return parent;
}

type ApiError = {
  code?: string;
  message?: string;
  detail?: { before?: string };
};

async function readError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.clone().json()) as { error?: ApiError };
    return body.error ?? {};
  } catch {
    return { message: await readApiError(response) };
  }
}

export async function runRemotePushReview(cli: Cli): Promise<void> {
  const range = cli.range!;
  const config = readConfig();
  const fromEnv = remoteFromEnv();
  const host = cli.remoteHost ?? fromEnv.host ?? config.remoteHost;
  const token = cli.remoteToken ?? fromEnv.token ?? config.remoteToken;
  if (!host || !token) {
    die(
      "remote_not_configured",
      "Remote review is not configured.",
      "set CM_REMOTE_HOST and CM_REMOTE_TOKEN, or pass --remote-host=... --remote-token=...",
    );
  }
  setCliInteractive(!cli.json);
  await withCliLogsToStderr(async () => {
    // A push that creates the branch has no "before": there is nothing it
    // changed to compare with.
    if (ZERO.test(range.before)) {
      notice(cli, "No changes to review.");
      exitWith(0);
      return;
    }
    const root = await gitRoot(process.cwd());
    await assertGitQuiet(root);
    const repo = await detectRemoteRepo(root, cli.repoOverride);
    const branch = await currentBranch(root, cli.branch);
    const remotes = (await git(root, ["remote"])).stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const remoteName =
      ["upstream", "origin"].find((name) => remotes.includes(name)) ??
      remotes[0]!;
    const after = await ensureCommit(root, remoteName, range.after);
    if (!after)
      die(
        "push_after_missing",
        `Could not find ${range.after} in this checkout.`,
      );
    let before = (await resolveCommit(root, range.before)) ?? range.before;

    const handshake = await remoteFetch(host, token, "/api/remote/handshake", {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: REMOTE_SCHEMA_VERSION,
        clientVersion: VERSION,
        repo,
        purpose: "push",
      }),
    });
    if (!handshake.ok) throw await handshakeFailure(handshake, host, repo);
    const hs = (await handshake.json()) as {
      schemaVersion: number;
      minClientSchema: number;
      serverVersion: string;
      repo: { fullName: string };
      sync: { intervalSeconds: number };
      limits: { maxBodyBytes: number };
      features?: string[];
    };
    if (REMOTE_SCHEMA_VERSION < hs.minClientSchema) {
      die(
        "upgrade_required",
        "This co-maintainer CLI is too old for the server.",
        REMOTE_CLI_UPGRADE_COMMAND,
        4,
      );
    }
    if (
      hs.schemaVersion < MIN_SERVER_SCHEMA ||
      !hs.features?.includes("push")
    ) {
      die(
        "server_too_old",
        `This server (version ${hs.serverVersion}) cannot review pushes.`,
        "Upgrade the server to 0.6.10 or later.",
        4,
      );
    }

    let submitted: { jobId: string; attached?: boolean } | undefined;
    // At most one retry: the server asks for a wider range when this push
    // was merged into a waiting review that only this step can diff.
    for (let attempt = 0; attempt < 2 && !submitted; attempt++) {
      const base = await diffBase(root, remoteName, before, after);
      const built = await buildLocalRevision(
        root,
        base,
        branch,
        runCommand,
        after,
      );
      if (built.revision.files.length === 0 && attempt === 0) {
        notice(cli, "No changes to review.");
        exitWith(0);
        return;
      }
      const body = JSON.stringify({
        schemaVersion: REMOTE_SCHEMA_VERSION,
        requestId: crypto.randomUUID(),
        repo: hs.repo.fullName,
        branch,
        revision: {
          title: "",
          description: "",
          baseLabel: branch,
          files: built.revision.files,
        },
        push: { before, after, ref: `refs/heads/${branch}` },
      });
      if (body.length > hs.limits.maxBodyBytes) {
        die(
          "payload_too_large",
          "This push is too large for the remote server limit.",
        );
      }
      const submit = await remoteFetch(host, token, "/api/remote/reviews", {
        method: "POST",
        body,
      });
      if (submit.status === 202) {
        submitted = (await submit.json()) as {
          jobId: string;
          attached?: boolean;
        };
        break;
      }
      if (submit.status === 200) {
        notice(cli, "No changes to review.");
        exitWith(0);
        return;
      }
      const error = await readError(submit);
      if (
        error.code === "range_extend" &&
        error.detail?.before &&
        attempt === 0
      ) {
        before = error.detail.before;
        continue;
      }
      if (error.code === "not_initialized_skipped") {
        notice(
          cli,
          `${error.message ?? "This repository is not initialized."} The commit got a skipped check run.`,
        );
        exitWith(0);
        return;
      }
      if (error.code === "not_default_branch") {
        notice(
          cli,
          error.message ?? "Commit watch reviews the default branch only.",
        );
        exitWith(0);
        return;
      }
      if (error.code === "not_initialized") {
        throw notInitializedError(repo, new URL(baseUrl(host)).host);
      }
      die(
        error.code ?? "remote_submit_failed",
        error.message ?? "The server refused the push.",
      );
    }
    if (!submitted) die("remote_submit_failed", "The server refused the push.");
    if (submitted.attached && !cli.json) {
      console.error(
        "The GitHub App is already reviewing this push, waiting for that review.",
      );
    }

    const deadline =
      Date.now() +
      (cli.timeoutMinutes ?? DEFAULT_PUSH_TIMEOUT_MINUTES) * 60_000;
    const intervalMs = hs.sync.intervalSeconds * 1000;
    let afterLogSeq = 0;
    for (;;) {
      const sync = await remoteFetch(
        host,
        token,
        `/api/remote/reviews/${submitted.jobId}/sync`,
        {
          method: "POST",
          body: JSON.stringify({
            schemaVersion: REMOTE_SCHEMA_VERSION,
            afterLogSeq,
            toolResults: [],
          }),
        },
      );
      if (!sync.ok) die("remote_sync_failed", await readApiError(sync));
      const payload = (await sync.json()) as {
        status: string;
        logs: Array<{ seq: number; message: string }>;
        result: Record<string, unknown> | null;
        abort: { reason: string; message: string } | null;
      };
      for (const line of payload.logs ?? []) {
        afterLogSeq = Math.max(afterLogSeq, line.seq);
        if (!cli.json) {
          console.error(
            cli.output === "github"
              ? neutralizeCommands(line.message)
              : stripControlChars(line.message),
          );
        }
      }
      if (payload.status === "done" && payload.result) {
        const findings = (payload.result.findings ?? []) as JsonReviewFinding[];
        const title = `${repo} · ${branch} · ${before.slice(0, 7)}..${after.slice(0, 7)}`;
        // A push review never blocks, so every finding is a warning.
        const human = humanFindingsFromJson(findings).map((row) => ({
          ...row,
          blocking: false,
        }));
        if (cli.json) {
          console.log(
            JSON.stringify({
              schemaVersion: 1,
              ok: true,
              mode: "push",
              ...payload.result,
            }),
          );
        } else if (cli.output === "github") {
          emitGithubOutput({ title, findings: human });
        } else {
          console.log(
            "\n" +
              formatHumanReview({
                title: `co-maintainer commit watch · ${title}`,
                guideBuiltAt: null,
                codegraphState: null,
                findings: human,
              }) +
              "\n",
          );
        }
        exitWith(0);
        return;
      }
      if (payload.status === "canceled" && payload.abort?.reason === "merged") {
        notice(
          cli,
          `${stripControlChars(payload.abort.message)} The result is on the dashboard.`,
        );
        exitWith(0);
        return;
      }
      if (payload.status === "failed" || payload.status === "canceled") {
        die(
          stripControlChars(payload.abort?.reason ?? "remote_failed"),
          stripControlChars(
            payload.abort?.message ?? "The push review did not complete.",
          ),
        );
      }
      if (Date.now() >= deadline) {
        notice(
          cli,
          `The review is still running on ${baseUrl(host)}. The result will be on the dashboard.`,
        );
        exitWith(0);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  });
}
