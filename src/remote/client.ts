import denoConfig from "../../deno.json" with { type: "json" };
import type { ReviewCliArgs } from "../cli/review_args.ts";
import { printLocalReview } from "../cli/review_output.ts";
import { isBlockingFinding } from "../cli/review_result.ts";
import { readConfig } from "../config.ts";
import { runCommand } from "../pr/checkout.ts";
import {
  assertGitQuiet,
  currentBranch,
  detectRemoteRepo,
  gitRoot,
  ReviewCliError,
} from "../local/git_ops.ts";
import {
  buildLocalRevision,
  mergeBase,
  resolveBaseRef,
} from "../local/git_revision.ts";
import { withCliLogsToStderr } from "../util/log.ts";
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

function die(
  code: string,
  message: string,
  hint?: string,
  exitCode = 2,
): never {
  throw new ReviewCliError(code, message, hint, exitCode);
}

function baseUrl(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    die(
      "remote_not_configured",
      "remoteHost must be an absolute http(s) URL.",
      "co-maintainer set --remote-host=https://your-server",
    );
  }
  return trimmed;
}

async function remoteFetch(
  host: string,
  token: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const url = `${baseUrl(host)}${path}`;
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return await fetch(url, { ...init, headers });
}

async function readApiError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    return String(body.error?.message ?? response.statusText);
  } catch {
    return response.statusText;
  }
}

export async function runRemoteReview(cli: ReviewCliArgs & { mode: "remote" }): Promise<void> {
  const config = readConfig();
  const host = config.remoteHost;
  const token = config.remoteToken;
  if (!host || !token) {
    die(
      "remote_not_configured",
      "Remote review is not configured.",
      "co-maintainer set --remote-host=... --remote-token=...",
    );
  }

  setCliInteractive(!cli.json);
  await withCliLogsToStderr(async () => {
    const root = await gitRoot(Deno.cwd());
    await assertGitQuiet(root);
    const repo = await detectRemoteRepo(root, cli.repoOverride);
    const branch = await currentBranch(root, cli.branch);

    const remotes = await runCommand("git", ["remote"], root);
    const remoteName = ["upstream", "origin"].find((n) =>
      remotes.stdout.split("\n").map((l) => l.trim()).includes(n)
    ) ?? remotes.stdout.split("\n").map((l) => l.trim()).filter(Boolean)[0]!;
    const base = await resolveBaseRef(
      root,
      remoteName,
      cli.toBranch,
      runCommand,
    );
    const baseSha = await mergeBase(root, base.ref, remoteName, runCommand);
    const built = await buildLocalRevision(root, baseSha, base.label, runCommand);
    if (built.revision.files.length === 0) {
      if (cli.json) {
        console.log(JSON.stringify({
          schemaVersion: 1,
          ok: true,
          mode: "remote",
          message: "No changes to review.",
        }));
      } else {
        console.log("No changes to review.");
      }
      Deno.exit(0);
    }

    const handshake = await remoteFetch(host, token, "/api/remote/handshake", {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: REMOTE_SCHEMA_VERSION,
        clientVersion: denoConfig.version,
        repo,
      }),
    });
    if (!handshake.ok) {
      die("remote_handshake_failed", await readApiError(handshake));
    }
    const hs = await handshake.json() as HandshakeResponse;
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
      capabilities: { tools: [] },
    };
    const serialized = JSON.stringify(submitBody);
    if (serialized.length > hs.limits.maxBodyBytes) {
      die("payload_too_large", "Diff is too large for the remote server limit.");
    }

    const submit = await remoteFetch(host, token, "/api/remote/reviews", {
      method: "POST",
      body: serialized,
    });
    if (submit.status !== 202) {
      die("remote_submit_failed", await readApiError(submit));
    }
    const { jobId } = await submit.json() as { jobId: string };

    let afterLogSeq = 0;
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
            toolResults: [],
          }),
        },
      );
      if (!sync.ok) {
        die("remote_sync_failed", await readApiError(sync));
      }
      const payload = await sync.json() as {
        status: string;
        logs: Array<{ seq: number; message: string }>;
        result: Record<string, unknown> | null;
        abort: { reason: string; message: string } | null;
      };
      for (const line of payload.logs ?? []) {
        afterLogSeq = Math.max(afterLogSeq, line.seq);
        if (!cli.json) console.error(line.message);
      }
      if (payload.status === "done" && payload.result) {
        if (cli.json) {
          console.log(JSON.stringify({
            schemaVersion: 1,
            ok: true,
            mode: "remote",
            ...payload.result,
          }));
        } else {
          const findings = payload.result.findings as unknown[] | undefined;
          const summary = JSON.stringify(payload.result.summary ?? {});
          printLocalReview(
            `co-maintainer review · ${repo} · ${branch} (remote)\n${summary}`,
            findings?.length
              ? `## Findings\n\n(${findings.length} finding(s) in JSON output)`
              : "## Findings\n\nNo actionable findings.",
          );
        }
        const findings = payload.result.findings as Array<{
          blocking?: boolean;
          severity?: string;
          title?: string;
        }> | undefined;
        const blocking = findings?.some((f) =>
          f.blocking === true ||
          isBlockingFinding(String(f.title ?? ""), String(f.severity ?? "P2"))
        ) ?? false;
        Deno.exit(blocking ? 1 : 0);
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
