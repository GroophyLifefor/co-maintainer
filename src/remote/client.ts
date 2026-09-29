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
import { readConfig, writeUserConfig, type ByokPolicy } from "../config.ts";
import { getEnv } from "../util/runtime.ts";
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
import { printRunSummary } from "../util/run_summary.ts";
import { costReasonText, type CostReason } from "../util/cost.ts";
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
  /** Additive feature list (CORE-110): a 0.5.0 server never sends this, which
   * is how BYOK gates itself on a server that predates it. */
  features?: string[];
  byok?: { policy: ByokPolicy };
  ai?: { provider: string };
};

const LOCAL_BYOK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** A plain-http, non-local host means the BYOK key travels in the clear
 * (CORE-111). Pulled out as a pure function so the rule is unit-testable
 * without standing up a plain-http fake server. */
export function byokHttpWarning(host: string): string | null {
  const url = new URL(baseUrl(host));
  if (url.protocol !== "http:" || LOCAL_BYOK_HOSTNAMES.has(url.hostname)) {
    return null;
  }
  return (
    `Warning: sending your AI key over plain http to ${url.hostname}. ` +
    "Anyone on the network path can read it."
  );
}

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

  // CORE-111: the client's own AI key, used only when this run turns BYOK
  // on. The env var wins so a hosted CI runner can supply it without writing
  // config, mirroring how CM_REMOTE_BYOK_POLICY overrides the server side.
  const byokKey = getEnv("CM_REMOTE_BYOK") ?? config.remoteByok;
  const byokEnabled = cli.remoteByok ?? config.remoteByokDefault ?? false;
  if (byokEnabled && !byokKey) {
    die(
      "remote_byok_not_configured",
      "No BYOK key is set.",
      "co-maintainer config set remote-byok <key>",
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

    // CORE-111: never silently fall back to the server's own key. Each of
    // these is a mismatch between what this run wants and what the server
    // will do, so all four are a hard stop.
    const serverSupportsByok = hs.features?.includes("byok") ?? false;
    if (byokEnabled && !serverSupportsByok) {
      die(
        "remote_byok_unsupported",
        `This server (version ${hs.serverVersion}) does not support your own key.`,
        "Upgrade the server or run without --remote-byok.",
      );
    }
    if (byokEnabled && hs.byok?.policy === "off") {
      die("remote_byok_rejected", "This server does not accept your own key.");
    }
    if (serverSupportsByok && hs.byok?.policy === "require" && !byokEnabled) {
      die(
        "remote_byok_required",
        "This server requires your own key.",
        "co-maintainer review --remote --remote-byok",
      );
    }
    if (byokEnabled && !cli.json) {
      const warning = byokHttpWarning(host);
      if (warning) console.error(warning);
      console.error(
        `Using your own key with the server's provider: ${hs.ai?.provider ?? "unknown"}.`,
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
      // CORE-111: only present when this run turned BYOK on; `byokKey` is
      // known to be set here because of the earlier `byokEnabled` guard.
      ...(byokEnabled ? { byok: { key: byokKey! } } : {}),
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
            | {
                tokensIn?: number;
                tokensOut?: number;
                costUsd?: number | null;
                costNote?: CostReason | null;
              }
            | undefined;
          if (usage) {
            const known = usage.costUsd !== null && usage.costUsd !== undefined;
            printRunSummary({
              durationMs: performance.now() - reviewStarted,
              tokensIn: usage.tokensIn ?? 0,
              tokensOut: usage.tokensOut ?? 0,
              costUsd: known ? usage.costUsd! : null,
              ...(!known && usage.costNote
                ? { costNote: costReasonText(usage.costNote) }
                : {}),
            });
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
