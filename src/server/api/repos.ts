import { errorResponse } from "../errors.ts";
import { AppClient, findInstallationForRepo } from "../../github/app.ts";
import {
  activateRepo,
  deactivateRepo,
  getRepo,
  listActiveRepos,
  updateRepoSettings,
} from "../../store/repos.ts";
import { readConfig, writeRepoConfig } from "../../config.ts";
import type { RepoConfig } from "../../config.ts";
import { parseRemakeCron } from "../../services/remake_cron.ts";
import { enqueueSetup } from "../../services/setup.ts";
import { enqueueManualReview } from "../../services/review.ts";
import { probePlan, recommendationPatch } from "../../services/probe.ts";
import { estimateInit, readJobHistory } from "../../ai/estimate.ts";
import { loadPrices } from "../../ai/pricing.ts";
import type { ModelPrice } from "../../ai/pricing.ts";
import {
  prDetail,
  repoKnowledge,
  RepoNotFound,
  repoOverview,
  repoPulls,
  requireActiveRepo,
} from "../../services/dashboard.ts";

const REPO =
  /^\/api\/repos\/([^/]+)\/([^/]+)(?:\/(remake|knowledge|pulls)(?:\/(\d+)(?:\/(review))?)?)?$/;

export async function handleReposRoute(
  request: Request,
  url: URL,
  githubApp?: { appId: string; privateKeyPem: string },
): Promise<Response> {
  if (url.pathname === "/api/repos" && request.method === "GET") {
    return Response.json({ items: listActiveRepos() });
  }

  if (url.pathname === "/api/repos/preview" && request.method === "POST") {
    if (!githubApp) {
      return errorResponse(
        422,
        "no_github_app",
        "Configure the GitHub App in Settings to preview a repository.",
      );
    }
    let body: { repo?: unknown };
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "bad_request", "expected a JSON body");
    }
    const repo = String(body.repo ?? "");
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      return errorResponse(
        400,
        "bad_request",
        "repo must look like owner/repo",
      );
    }
    let installationId: number | undefined;
    try {
      installationId = await findInstallationForRepo(
        githubApp.appId,
        githubApp.privateKeyPem,
        repo,
      );
    } catch {
      return errorResponse(
        422,
        "app_lookup_failed",
        "Could not verify the GitHub App's repository access.",
      );
    }
    if (installationId === undefined) {
      return errorResponse(
        422,
        "app_access_denied",
        `The GitHub App cannot access ${repo}.`,
      );
    }
    if (getRepo(repo)?.active) {
      return errorResponse(409, "already_added", `${repo} is already added.`);
    }
    const client = new AppClient(
      githubApp.appId,
      githubApp.privateKeyPem,
      installationId,
    );
    try {
      const plan = await probePlan(client, repo, {
        ghConcurrent: 1,
        log: () => {},
      });
      const config = readConfig();
      const needsPrices =
        config.ai === "openrouter" &&
        Boolean(config.lowModel && config.highModel);
      const [prices, history] = await Promise.all([
        needsPrices
          ? loadPrices()
          : Promise.resolve({
              prices: new Map<string, ModelPrice>(),
              source: "unavailable" as const,
            }),
        readJobHistory(repo),
      ]);
      const estimate = estimateInit({
        pullRequests: plan.analysis.includePullRequests
          ? Number(plan.analysis.report.pullRequests ?? 0)
          : 0,
        includeCodebase: plan.analysis.includePullRequests,
        lowModel: config.lowModel,
        highModel: config.highModel,
        prices: prices.prices,
        history,
      });
      return Response.json({
        repo,
        command: plan.command,
        recommendation: plan.recommendation,
        patch: recommendationPatch(plan.recommendation),
        reasons: plan.analysis.reasons,
        report: plan.report,
        estimate,
        estimateBasis: estimate.basis,
      });
    } catch (error) {
      return errorResponse(
        422,
        "probe_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (url.pathname === "/api/repos" && request.method === "POST") {
    let body: { repo?: unknown; patch?: unknown };
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "bad_request", "expected a JSON body");
    }
    const repo = String(body.repo ?? "");
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      return errorResponse(
        400,
        "bad_request",
        "repo must look like owner/repo",
      );
    }
    let installationId: number | undefined;
    if (githubApp) {
      try {
        installationId = await findInstallationForRepo(
          githubApp.appId,
          githubApp.privateKeyPem,
          repo,
        );
      } catch {
        return errorResponse(
          422,
          "app_lookup_failed",
          "Could not verify the GitHub App's repository access.",
        );
      }
      if (installationId === undefined) {
        return errorResponse(
          422,
          "app_access_denied",
          `The GitHub App cannot access ${repo}.`,
        );
      }
    }
    // `patch` is the confirmed preview. It is optional so a caller that
    // never opened the preview keeps the old behavior; when present it is
    // written before `activateRepo` so the enqueued init reads it.
    const patch =
      body.patch && typeof body.patch === "object"
        ? (body.patch as RepoConfig)
        : undefined;
    if (patch && Object.keys(patch).length > 0) {
      await writeRepoConfig(repo, patch);
    }
    activateRepo(repo, installationId);
    try {
      const { id } = enqueueSetup(repo, "init");
      return Response.json({ jobId: id });
    } catch (error) {
      return errorResponse(422, "setup_incomplete", String(error));
    }
  }

  const match = REPO.exec(url.pathname);
  if (!match) {
    return errorResponse(404, "not_found", `no route for ${url.pathname}`);
  }
  const fullName = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
  const sub = match[3];
  const pr = match[4] ? Number(match[4]) : undefined;
  const action = match[5];

  try {
    if (!sub && request.method === "GET") {
      return Response.json(repoOverview(fullName));
    }
    if (!sub && request.method === "PATCH") {
      requireActiveRepo(fullName);
      let body: Record<string, unknown>;
      try {
        body = await request.json();
      } catch {
        return errorResponse(400, "bad_request", "expected a JSON body");
      }
      const cronPatch: RepoConfig = {};
      if ("remakeCron" in body) {
        const raw = body.remakeCron;
        if (raw === null || raw === "") {
          cronPatch.remakeCron = undefined;
        } else if (typeof raw === "string") {
          try {
            parseRemakeCron(raw);
          } catch (error) {
            return errorResponse(
              422,
              "invalid_cron",
              error instanceof Error ? error.message : String(error),
            );
          }
          cronPatch.remakeCron = raw.trim();
        } else {
          return errorResponse(
            422,
            "invalid_cron",
            "remakeCron must be text or null",
          );
        }
      }
      const patch: Parameters<typeof updateRepoSettings>[1] = {};
      if (typeof body.autoReview === "boolean") {
        patch.auto_review = body.autoReview ? 1 : 0;
      }
      if (typeof body.skipDrafts === "boolean") {
        patch.skip_drafts = body.skipDrafts ? 1 : 0;
      }
      if (typeof body.skipBots === "boolean") {
        patch.skip_bots = body.skipBots ? 1 : 0;
      }
      if (typeof body.useCodegraph === "boolean") {
        patch.use_codegraph = body.useCodegraph ? 1 : 0;
      }
      if (
        body.reviewScope === "whole-pr" ||
        body.reviewScope === "incremental"
      ) {
        patch.review_scope = body.reviewScope;
      }
      updateRepoSettings(fullName, patch);
      const init: Record<string, number | undefined> = {};
      for (const key of [
        "maxPrMonths",
        "maxCommits",
        "maxPullRequestChangeLines",
        "maxComments",
      ] as const) {
        if (typeof body[key] === "number" && Number.isFinite(body[key])) {
          init[key] = body[key] as number;
        }
      }
      if (Object.keys(init).length > 0 || "remakeCron" in cronPatch) {
        await writeRepoConfig(fullName, { ...init, ...cronPatch });
      }
      return Response.json({ ok: true });
    }
    if (!sub && request.method === "DELETE") {
      requireActiveRepo(fullName);
      deactivateRepo(fullName);
      return Response.json({ ok: true });
    }
    if (sub === "remake" && request.method === "POST") {
      const { id } = enqueueSetup(fullName, "remake");
      return Response.json({ jobId: id });
    }
    if (sub === "knowledge" && request.method === "GET") {
      return Response.json(await repoKnowledge(fullName));
    }
    if (
      sub === "pulls" &&
      pr &&
      action === "review" &&
      request.method === "POST"
    ) {
      requireActiveRepo(fullName);
      const { id } = enqueueManualReview(fullName, pr);
      return Response.json({ jobId: id });
    }
    if (sub === "pulls" && pr && request.method === "GET") {
      return Response.json(prDetail(fullName, pr));
    }
    if (sub === "pulls" && request.method === "GET") {
      const page = Number(url.searchParams.get("page") ?? 1);
      const per = Number(url.searchParams.get("per") ?? 20);
      return Response.json(repoPulls(fullName, page, per));
    }
  } catch (error) {
    if (error instanceof RepoNotFound) {
      return errorResponse(404, "not_found", error.message);
    }
    return errorResponse(422, "setup_incomplete", String(error));
  }

  return errorResponse(404, "not_found", `no route for ${url.pathname}`);
}
