import { VERSION } from "../version.ts";
import type { ReviewCliArgs } from "../cli/review_args.ts";
import { CliError, EXIT_USAGE, exitWith } from "../cli/error.ts";
import {
  formatHumanReview,
  humanFindingsFromJson,
  type JsonReviewFinding,
  reviewExitCodeFromJsonFindings,
} from "../cli/review_result.ts";
import { baseUrl, die, readApiError, remoteFetch } from "./http.ts";
import { readConfig, writeUserConfig } from "../config.ts";
import { prepareLocalCodegraph } from "../local/codegraph_prepare.ts";
import { canPrompt } from "../tools/codegraph.ts";
import {
  runRemoteToolCalls,
  toolHandlerMap,
  type RemoteToolCall,
} from "./client_tools.ts";
import { REMOTE_KNOWN_TOOL_NAMES } from "./schema.ts";
import { runCommand } from "../pr/checkout.ts";
import {
  assertGitQuiet,
  currentBranch,
  detectRemoteRepo,
  gitRoot,
} from "../local/git_ops.ts";
import {
  buildLocalRevision,
  mergeBase,
  resolveBaseRef,
} from "../local/git_revision.ts";
import { withCliLogsToStderr } from "../util/log.ts";
import { printRunSummary, summaryFromMetrics } from "../util/run_summary.ts";
import { setCliInteractive } from "../cli/args.ts";
import {
  MIN_SERVER_SCHEMA,
  REMOTE_CLI_UPGRADE_COMMAND,
  REMOTE_SCHEMA_VERSION,
} from "./schema.ts";

type HandshakeResponse = {
  schemaVersion: number;
  minClientSchema: number;
  serverVersion: string;
  repo: { fullName: string; defaultBranch: string | null };
  sync: { intervalSeconds: number; timeoutSeconds: number };
  limits: { maxBodyBytes: number };
};

export async function runRemoteReview(
  cli: ReviewCliArgs & { mode: "remote" },
): Promise<void> {
  const config = readConfig();
  // Inline flags win over the saved config for this run only (CORE-25), so a
  // one-off review does not have to be written to disk first.
  const host = cli.remoteHost ?? config.remoteHost;
  const token = cli.remoteToken ?? config.remoteToken;
  if (!host || !token) {
    die(
      "remote_not_configured",
      "Remote review is not configured.",
      "co-maintainer config set remote-host https://your-server " +
        "&& co-maintainer config set remote-token <token> " +
        "(or pass --remote-host=... --remote-token=... for one run)",
    );
  }

  setCliInteractive(!cli.json);
  await withCliLogsToStderr(async () => {
    const reviewStarted = performance.now();
    const root = await gitRoot(process.cwd());
    await assertGitQuiet(root);
    const repo = await detectRemoteRepo(root, cli.repoOverride);
    const branch = await currentBranch(root, cli.branch);

    const remotes = await runCommand("git", ["remote"], root);
    const remoteName =
      ["upstream", "origin"].find((n) =>
        remotes.stdout
          .split("\n")
          .map((l) => l.trim())
          .includes(n),
      ) ??
      remotes.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)[0]!;
    const base = await resolveBaseRef(
      root,
      remoteName,
      cli.toBranch,
      runCommand,
    );
    const baseSha = await mergeBase(root, base.ref, remoteName, runCommand);
    const built = await buildLocalRevision(
      root,
      baseSha,
      base.label,
      runCommand,
    );
    if (built.revision.files.length === 0) {
      if (cli.json) {
        console.log(
          JSON.stringify({
            schemaVersion: 1,
            ok: true,
            mode: "remote",
            message: "No changes to review.",
          }),
        );
      } else {
        console.log("No changes to review.");
      }
      exitWith(0);
    }

    const handshake = await remoteFetch(host, token, "/api/remote/handshake", {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: REMOTE_SCHEMA_VERSION,
        clientVersion: VERSION,
        repo,
      }),
    });
    if (!handshake.ok) {
      die("remote_handshake_failed", await readApiError(handshake));
    }
    const hs = (await handshake.json()) as HandshakeResponse;
    if (REMOTE_SCHEMA_VERSION < hs.minClientSchema) {
      die(
        "upgrade_required",
        "This co-maintainer CLI is too old for the server.",
        REMOTE_CLI_UPGRADE_COMMAND,
        4,
      );
    }
    if (hs.schemaVersion < MIN_SERVER_SCHEMA) {
      die(
        "server_too_old",
        "The dashboard server is too old for this CLI.",
        undefined,
        4,
      );
    }

    const hostKey = baseUrl(host);
    const shown = config.remoteNoticeShownFor ?? [];
    if (!shown.includes(hostKey) && !cli.json) {
      console.error(
        "Remote review sends your unpublished diff to the server you configured. " +
          "Use a host you trust.",
      );
      await writeUserConfig({
        remoteNoticeShownFor: [...shown, hostKey],
      });
    }

    const codegraphPrep = await prepareLocalCodegraph({
      gitRoot: root,
      enabled: !cli.disableCodegraph,
      allowInstall: cli.allowToolInstall,
      // `--json` must stay machine-readable; `canPrompt` adds TTY and CI (F01).
      interactive: !cli.json && canPrompt(),
    });
    const localTools = toolHandlerMap(codegraphPrep.tools);
    const capabilityTools = [...localTools.keys()]
      .filter((name) => REMOTE_KNOWN_TOOL_NAMES.has(name))
      .map((name) => ({ name }));

    const requestId = crypto.randomUUID();
    const submitBody = {
      schemaVersion: REMOTE_SCHEMA_VERSION,
      requestId,
      repo: hs.repo.fullName,
      branch,
      toBranch: cli.toBranch ?? hs.repo.defaultBranch ?? undefined,
      fresh: cli.fresh,
      revision: {
        title: built.revision.title,
        description: built.revision.description,
        baseLabel: built.revision.baseLabel,
        files: built.revision.files,
      },
      capabilities: { tools: capabilityTools },
    };
    const serialized = JSON.stringify(submitBody);
    if (serialized.length > hs.limits.maxBodyBytes) {
      die(
        "payload_too_large",
        "Diff is too large for the remote server limit.",
      );
    }

    const submit = await remoteFetch(host, token, "/api/remote/reviews", {
      method: "POST",
      body: serialized,
    });
    if (submit.status !== 202) {
      die("remote_submit_failed", await readApiError(submit));
    }
    const { jobId } = (await submit.json()) as { jobId: string };

    let afterLogSeq = 0;
    let toolResults: Awaited<ReturnType<typeof runRemoteToolCalls>> = [];
    const intervalMs = hs.sync.intervalSeconds * 1000;
    while (true) {
      const sync = await remoteFetch(
        host,
        token,
        `/api/remote/reviews/${jobId}/sync`,
        {
          method: "POST",
          body: JSON.stringify({
            schemaVersion: REMOTE_SCHEMA_VERSION,
            afterLogSeq,
            toolResults,
          }),
        },
      );
      toolResults = [];
      if (!sync.ok) {
        die("remote_sync_failed", await readApiError(sync));
      }
      const payload = (await sync.json()) as {
        status: string;
        toolCalls?: RemoteToolCall[];
        logs: Array<{ seq: number; message: string }>;
        result: Record<string, unknown> | null;
        abort: { reason: string; message: string } | null;
      };
      for (const line of payload.logs ?? []) {
        afterLogSeq = Math.max(afterLogSeq, line.seq);
        if (!cli.json) console.error(line.message);
      }
      if (payload.toolCalls?.length) {
        toolResults = await runRemoteToolCalls(payload.toolCalls, localTools);
        continue;
      }
      if (payload.status === "done" && payload.result) {
        if (cli.json) {
          console.log(
            JSON.stringify({
              schemaVersion: 1,
              ok: true,
              mode: "remote",
              ...payload.result,
            }),
          );
        } else {
          const findings = (payload.result.findings ??
            []) as JsonReviewFinding[];
          const resultGuide = payload.result.guide as
            | { builtAt?: string | null }
            | undefined;
          const resultCodegraph = payload.result.codegraph as
            | { state?: "used" | "disabled" | "unavailable" }
            | undefined;
          console.log(
            "\n" +
              formatHumanReview({
                title: `co-maintainer review · ${repo} · ${branch} (remote)`,
                guideBuiltAt: resultGuide?.builtAt ?? null,
                codegraphState: resultCodegraph?.state ?? null,
                findings: humanFindingsFromJson(findings),
              }) +
              "\n",
          );
          const usage = payload.result.usage as
            | { tokensIn?: number; tokensOut?: number; costUsd?: number | null }
            | undefined;
          if (usage) {
            printRunSummary(
              summaryFromMetrics(
                {
                  calls: 0,
                  tokensIn: usage.tokensIn ?? 0,
                  tokensOut: usage.tokensOut ?? 0,
                  cost: usage.costUsd ?? 0,
                  costKnown:
                    usage.costUsd !== null && usage.costUsd !== undefined,
                },
                performance.now() - reviewStarted,
              ),
            );
          }
        }
        const findings = (payload.result.findings ?? []) as JsonReviewFinding[];
        exitWith(reviewExitCodeFromJsonFindings(findings));
        // `done` is terminal. Without this return the loop polls `sync` again
        // and, since the server keeps reporting the same finished job, the
        // client reprints the result and re-requests forever (CORE-25).
        return;
      }
      if (payload.status === "failed" || payload.status === "canceled") {
        die(
          payload.abort?.reason ?? "remote_failed",
          payload.abort?.message ?? "Remote review did not complete.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  });
}
