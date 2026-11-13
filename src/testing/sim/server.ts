/** The `serve` side of a simulated run, with no port and no worker loop.
 *
 * `start` does what `serve` does before it listens: the App credentials and
 * the webhook secret in config.json, app.db open, CLI-built repositories
 * added, every job handler registered. A webhook is a signed `Request`
 * handed to the real `handleWebhookRequest`, and the jobs it queues run to
 * their end with the real `claimAndRun`, one after another. The remote
 * server's routes are reached through the caught fetch at `REMOTE_URL`. */
import { createHmac, randomUUID } from "node:crypto";
import type { SimComment, SimGithub, SimPull } from "./github.ts";
import { REMOTE_URL } from "./fetch.ts";
import type { Trace } from "./trace.ts";
import type { World } from "./world.ts";

type Json = Record<string, unknown>;

export type Delivery = {
  status: number;
  /** The handler's JSON answer: `outcome`, `reason`, `jobId`. */
  body: Json;
};

export type DeliverOptions = {
  /** Signs with this secret instead of the configured one. */
  secret?: string;
  deliveryId?: string;
};

/** The webhook payloads GitHub sends, built from the simulated GitHub so
 * they say what the API says. */
export class Payloads {
  private readonly github: SimGithub;
  constructor(github: SimGithub) {
    this.github = github;
  }

  private common(repoName: string, sender: string): Json {
    const repo = this.github.world.repos.get(repoName);
    if (!repo) throw new Error(`e2e:simulate has no repository ${repoName}`);
    return {
      repository: this.github.repoJson(repo),
      installation: {
        id: this.github.installation.id,
        app_slug: "co-maintainer-sim",
      },
      sender: { login: sender, type: "User" },
    };
  }

  /** `opened`, `synchronize`, `reopened`, `ready_for_review`, `closed`,
   * `labeled` (with `label`). */
  pullRequest(pull: SimPull, action: string, label?: string): Json {
    return {
      action,
      number: pull.number,
      pull_request: this.github.pullJson(pull),
      ...(label ? { label: { name: label } } : {}),
      ...this.common(pull.repo, pull.author),
    };
  }

  /** A comment on the pull request's conversation. */
  issueComment(pull: SimPull, comment: SimComment): Json {
    const json = this.github.pullJson(pull);
    return {
      action: "created",
      issue: {
        number: pull.number,
        title: pull.title,
        user: json.user,
        author_association: pull.association,
        labels: json.labels,
        draft: pull.draft,
        pull_request: { url: json.html_url },
      },
      comment: this.github.commentJson(comment),
      ...this.common(pull.repo, comment.user.login),
    };
  }

  /** A comment on a diff line, or a reply to one. */
  reviewComment(pull: SimPull, comment: SimComment): Json {
    return {
      action: "created",
      comment: this.github.commentJson(comment),
      pull_request: this.github.pullJson(pull),
      ...this.common(pull.repo, comment.user.login),
    };
  }

  /** A push to a branch, by default the repository's default branch. */
  push(repoName: string, before: string, after: string, ref?: string): Json {
    const repo = this.github.world.repos.get(repoName);
    return {
      ref: ref ?? `refs/heads/${repo?.defaultBranch ?? "main"}`,
      before,
      after,
      deleted: false,
      ...this.common(repoName, "sim-maintainer"),
    };
  }
}

export class SimServer {
  readonly payloads: Payloads;
  private readonly world: World;
  private readonly trace: Trace;
  private readonly aiConfig: Record<string, unknown>;
  private started = false;

  /** `aiConfig` is the run's AI provider, key and models, as config.json
   * names them (`ai`, `token`, `lowModel`, `highModel`). */
  constructor(world: World, trace: Trace, aiConfig: Record<string, unknown>) {
    this.world = world;
    this.trace = trace;
    this.aiConfig = aiConfig;
    this.payloads = new Payloads(world.github);
  }

  /** What `serve` does before it listens. `config` is merged into
   * config.json after the App credentials and the run's AI settings, so a
   * flow can set a policy default or leave the webhook secret out. */
  async start(config: Record<string, unknown> = {}): Promise<void> {
    const { secrets } = this.world;
    this.world.writeConfig({
      githubAppId: secrets.appId,
      githubAppPrivateKey: secrets.appPrivateKey,
      githubWebhookSecret: secrets.webhookSecret,
      ...this.aiConfig,
      ...config,
    });
    const { openAppDb } = await import("../../store/app_db.ts");
    await openAppDb();
    const { discoverCliRepos } = await import("../../services/cli_repos.ts");
    await discoverCliRepos();
    (await import("../../services/setup.ts")).registerSetupJobHandler();
    (await import("../../services/review.ts")).registerReviewJobHandler();
    (
      await import("../../services/remote_review.ts")
    ).registerRemoteReviewHandler();
    (await import("../../services/replies.ts")).registerReplyJobHandler();
    (
      await import("../../services/push_review.ts")
    ).registerPushReviewHandlers();
    (
      await import("../../services/watch_comments.ts")
    ).registerWatchCommentHandler();
    this.started = true;
  }

  /** Hands a signed delivery to the real webhook handler. The secret is the
   * one config.json holds, read the way `serve` reads it per request. */
  async deliver(
    event: string,
    payload: Json,
    options: DeliverOptions = {},
  ): Promise<Delivery> {
    const { readConfig } = await import("../../config.ts");
    const { handleWebhookRequest } =
      await import("../../server/webhook/index.ts");
    const configured = readConfig().githubWebhookSecret;
    const secret = options.secret ?? configured ?? "";
    const raw = JSON.stringify(payload);
    const deliveryId = options.deliveryId ?? randomUUID();
    const startMs = this.trace.now();
    const request = new Request("http://serve.simulate.test/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
      },
      body: raw,
    });
    const response = await handleWebhookRequest(request, configured);
    const body = (await response.json()) as Json;
    this.trace.webhooks.push({
      step: this.trace.step,
      startMs,
      event,
      ...(typeof payload.action === "string" ? { action: payload.action } : {}),
      deliveryId,
      status: response.status,
      response: body,
    });
    return { status: response.status, body };
  }

  /** Runs every queued job, and any job those queue, to its end. Returns the
   * jobs that finished, in the order they finished. */
  async runJobs(): Promise<{ id: string; type: string; status: string }[]> {
    const { claimAndRun } = await import("../../services/jobs.ts");
    const { listJobs } = await import("../../store/jobs.ts");
    const seen = new Set(this.trace.jobs.map((job) => job.id));
    const finished: { id: string; type: string; status: string }[] = [];
    for (let guard = 0; guard < 100; guard++) {
      if (!(await claimAndRun())) break;
      for (const job of listJobs().reverse()) {
        if (seen.has(job.id) || job.status === "queued") continue;
        if (job.status === "running") continue;
        seen.add(job.id);
        this.trace.jobs.push({
          step: this.trace.step,
          id: job.id,
          type: job.type,
          repo: job.repo,
          status: job.status,
          error: job.error ?? null,
        });
        finished.push({ id: job.id, type: job.type, status: job.status });
      }
    }
    return finished;
  }

  /** A remote review token, created the way the dashboard creates one. It
   * joins the secrets the leak check looks for. */
  async remoteToken(name = "simulate"): Promise<string> {
    const { createRemoteToken } =
      await import("../../services/remote_tokens.ts");
    const { token } = await createRemoteToken(name);
    this.world.secrets.extra[`remote token ${name}`] = token;
    return token;
  }

  /** The remote server's URL, answered in this process. */
  get remoteUrl(): string {
    return REMOTE_URL;
  }

  async stop(): Promise<void> {
    const { closeAppDb, isAppDbOpen } = await import("../../store/app_db.ts");
    if (isAppDbOpen()) await closeAppDb();
    this.started = false;
  }

  get running(): boolean {
    return this.started;
  }
}
