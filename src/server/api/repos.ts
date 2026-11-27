import { AI_PROVIDERS } from "../../ai/provider.ts";
import {
  DiagramSettingError,
  diagramOptionsFrom,
} from "../../review/diagram.ts";
import { parseCompanionsSetting } from "../../pr/companion_prs.ts";
import { errorResponse } from "../errors.ts";
import { canonicalRepoName } from "../../util/repo_name.ts";
import { AppClient, findInstallationForRepo } from "../../github/app.ts";
import {
  activateRepo,
  clearRepoKnowledge,
  deactivateRepo,
  resumeRepo,
  getRepo,
  listActiveRepos,
  updateRepoSettings,
} from "../../store/repos.ts";
import { readConfig, reposDir, writeRepoConfig } from "../../config.ts";
import { existsSync } from "node:fs";
import type { RepoConfig } from "../../config.ts";
import {
  checkReviewSystemPrompt,
  reviewSystemPromptLimit,
} from "../../review/system_prompt.ts";
import { parseRemakeCron } from "../../services/remake_cron.ts";
import { excludePatternError } from "../../pr/exclude.ts";
import {
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
} from "../../services/concurrency.ts";
import {
  parsePolicy,
  policyToStore,
  describePolicy,
} from "../../services/review_policy.ts";
import { enqueueSetup } from "../../services/setup.ts";
import { appReady, filterRepoList } from "../../services/repo_list.ts";
import { enqueueManualReview } from "../../services/review.ts";
import { probePlan, recommendationPatch } from "../../services/probe.ts";
import { estimateProbe } from "../../services/probe_estimate.ts";
import { estimateSummary } from "../../services/probe_render.ts";
import { resolveConcurrency } from "../../services/concurrency.ts";
import {
  listReposForHome,
  prDetail,
  repoKnowledge,
  RepoNotFound,
  repoOverview,
  repoPulls,
  requireActiveRepo,
} from "../../services/dashboard.ts";
import { clearOneRepo } from "./knowledge.ts";
import { audit, repoSnapshot, settingChanges } from "../../services/audit.ts";

const REPO =
  /^\/api\/repos\/([^/]+)\/([^/]+)(?:\/(remake|resume|knowledge|pulls)(?:\/(\d+)(?:\/(review))?)?)?$/;

export async function handleReposRoute(
  request: Request,
  url: URL,
  githubApp?: { appId: string; privateKeyPem: string },
): Promise<Response> {
  if (url.pathname === "/api/repos" && request.method === "GET") {
    const q = url.searchParams.get("q");
    const status = url.searchParams.get("status");
    if (q === null && status === null) {
      return Response.json({ items: listActiveRepos() });
    }
    const items = filterRepoList(
      listReposForHome(),
      { q: q ?? undefined, status: status ?? undefined },
      appReady(),
    );
    return Response.json({ items: items.map((item) => item.repo) });
  }

  // The plain sentences shown under the policy editor before it is saved, so
  // the wording lives in one place and the page never rebuilds it.
  if (
    url.pathname === "/api/repos/policy-preview" &&
    request.method === "POST"
  ) {
    let body: { policy?: unknown };
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "bad_request", "expected a JSON body");
    }
    const parsed = parsePolicy(body.policy);
    if (!parsed.ok) return errorResponse(422, "invalid_policy", parsed.problem);
    return Response.json({ summary: describePolicy(parsed.value) });
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
    const repo = canonicalRepoName(String(body.repo ?? ""));
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
      const concurrency = resolveConcurrency(repo, config);
      const ai = config.ai ?? "none";
      const probe = await estimateProbe(plan, {
        repo,
        ai,
        lowModel: config.lowModel,
        highModel: config.highModel,
        ghConcurrent: concurrency.gh,
        aiConcurrent: concurrency.ai,
      });
      const estimate = probe.recommended.ai;
      return Response.json({
        repo,
        command: plan.command,
        recommendation: plan.recommendation,
        patch: recommendationPatch(plan.recommendation),
        reasons: plan.analysis.reasons,
        report: plan.report,
        estimate,
        estimateBasis: estimate.basis,
        summary: estimateSummary(repo, probe, ai),
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
    let body: { repo?: unknown; patch?: unknown; reviewPolicy?: unknown };
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "bad_request", "expected a JSON body");
    }
    const repo = canonicalRepoName(String(body.repo ?? ""));
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
    // Checked before anything is written, so a bad policy leaves no half
    // added repository behind.
    let policyToKeep: string | null | undefined;
    if ("reviewPolicy" in body) {
      const stored = policyToStore(body.reviewPolicy, { allowLegacy: false });
      if (!stored.ok)
        return errorResponse(422, "invalid_policy", stored.problem);
      policyToKeep = stored.value;
    }
    // `patch` is the confirmed preview. It is optional so a caller that
    // never opened the preview keeps the old behavior. When present it is
    // written before `activateRepo` so the enqueued init reads it.
    const patch =
      body.patch && typeof body.patch === "object"
        ? (body.patch as RepoConfig)
        : undefined;
    if (patch && Object.keys(patch).length > 0) {
      await writeRepoConfig(repo, patch);
    }
    activateRepo(repo, installationId);
    if (policyToKeep !== undefined) {
      updateRepoSettings(repo, { review_policy_json: policyToKeep });
    }
    audit("repo", "Added a repository", { target: repo });
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
      const before = repoSnapshot(fullName);
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
          cronPatch.remakeCronDraft = undefined;
        } else if (typeof raw === "string") {
          try {
            parseRemakeCron(raw);
          } catch (error) {
            // Keep what was typed only for the form, never as a schedule.
            await writeRepoConfig(fullName, { remakeCronDraft: raw });
            return errorResponse(
              422,
              "invalid_cron",
              error instanceof Error ? error.message : String(error),
            );
          }
          cronPatch.remakeCron = raw.trim();
          cronPatch.remakeCronDraft = undefined;
        } else {
          return errorResponse(
            422,
            "invalid_cron",
            "remakeCron must be text or null",
          );
        }
      }
      const patch: Parameters<typeof updateRepoSettings>[1] = {};
      // The repository's own review instructions live in config.json, not the
      // database, so they go through writeRepoConfig below.
      const promptPatch: RepoConfig = {};
      if ("reviewSystemPromptMaxChars" in body) {
        const raw = body.reviewSystemPromptMaxChars;
        if (raw === null || raw === "") {
          promptPatch.reviewSystemPromptMaxChars = undefined;
        } else if (typeof raw === "number" && Number.isInteger(raw)) {
          promptPatch.reviewSystemPromptMaxChars = raw;
        } else {
          return errorResponse(
            422,
            "invalid_review_system_prompt_limit",
            "reviewSystemPromptMaxChars must be an integer (0 or -1 for no limit) or null",
          );
        }
      }
      if ("reviewSystemPrompt" in body) {
        const raw = body.reviewSystemPrompt;
        if (raw === null || raw === "") {
          promptPatch.reviewSystemPrompt = undefined;
        } else if (typeof raw === "string") {
          promptPatch.reviewSystemPrompt = raw.trim() === "" ? undefined : raw;
        } else {
          return errorResponse(
            422,
            "invalid_review_system_prompt",
            "reviewSystemPrompt must be text or null",
          );
        }
      }
      if ("reviewExclude" in body) {
        const raw = body.reviewExclude;
        if (raw === null || (typeof raw === "string" && raw.trim() === "")) {
          promptPatch.reviewExclude = undefined;
        } else if (typeof raw === "string") {
          const problem = excludePatternError(raw);
          if (problem) {
            return errorResponse(422, "invalid_review_exclude", problem);
          }
          promptPatch.reviewExclude = raw;
        } else {
          return errorResponse(
            422,
            "invalid_review_exclude",
            "reviewExclude must be text or null",
          );
        }
      }
      // The prompt after this write is the one given here, or the stored one.
      // Lowering the cap re-checks the stored prompt too.
      if (
        "reviewSystemPrompt" in promptPatch ||
        "reviewSystemPromptMaxChars" in promptPatch
      ) {
        const existing = readConfig().repos?.[fullName] ?? {};
        const effectiveMax =
          "reviewSystemPromptMaxChars" in promptPatch
            ? promptPatch.reviewSystemPromptMaxChars
            : existing.reviewSystemPromptMaxChars;
        const effectivePrompt =
          "reviewSystemPrompt" in promptPatch
            ? promptPatch.reviewSystemPrompt
            : existing.reviewSystemPrompt;
        if (effectivePrompt !== undefined) {
          const problem = checkReviewSystemPrompt(
            effectivePrompt,
            reviewSystemPromptLimit({
              reviewSystemPromptMaxChars: effectiveMax,
            }),
          );
          if (problem) {
            return errorResponse(
              422,
              "invalid_review_system_prompt",
              `reviewSystemPrompt ${problem}`,
            );
          }
        }
      }
      if ("reviewPolicy" in body) {
        const stored = policyToStore(body.reviewPolicy, { allowLegacy: true });
        if (!stored.ok) {
          return errorResponse(422, "invalid_policy", stored.problem);
        }
        patch.review_policy_json = stored.value;
      }
      const speedPatch: RepoConfig = {};
      for (const key of ["ghConcurrent", "aiConcurrent"] as const) {
        if (!(key in body)) continue;
        const raw = body[key];
        if (raw === null || raw === "") {
          speedPatch[key] = undefined;
          continue;
        }
        if (
          typeof raw !== "number" ||
          !Number.isInteger(raw) ||
          raw < MIN_CONCURRENCY ||
          raw > MAX_CONCURRENCY
        ) {
          return errorResponse(
            422,
            "invalid_concurrency",
            `${key} must be an integer between ${MIN_CONCURRENCY} and ${MAX_CONCURRENCY}`,
          );
        }
        speedPatch[key] = raw;
      }
      const blockingPatch: RepoConfig = {};
      if ("reviewBlocking" in body) {
        const raw = body.reviewBlocking;
        if (raw === null || raw === "") {
          blockingPatch.reviewBlocking = undefined;
        } else if (raw === "model" || raw === "severity") {
          blockingPatch.reviewBlocking = raw;
        } else {
          return errorResponse(
            422,
            "invalid_review_blocking",
            "reviewBlocking must be model or severity",
          );
        }
      }
      if ("reviewEvent" in body) {
        const raw = body.reviewEvent;
        if (raw === null || raw === "") {
          blockingPatch.reviewEvent = undefined;
        } else if (
          raw === "auto" ||
          raw === "comment" ||
          raw === "auto-forks"
        ) {
          blockingPatch.reviewEvent = raw;
        } else {
          return errorResponse(
            422,
            "invalid_review_event",
            "reviewEvent must be auto, comment or auto-forks",
          );
        }
      }
      if (typeof body.autoReview === "boolean") {
        patch.auto_review = body.autoReview ? 1 : 0;
      }
      if (typeof body.skipDrafts === "boolean") {
        patch.skip_drafts = body.skipDrafts ? 1 : 0;
      }
      if (typeof body.skipBots === "boolean") {
        patch.skip_bots = body.skipBots ? 1 : 0;
      }
      // The three switches only mean something under the legacy policy. A
      // repository on a real policy refuses them instead of silently ignoring
      // the change, and one on the server default is pinned to the switches
      // the moment someone uses them.
      if (
        patch.auto_review !== undefined ||
        patch.skip_drafts !== undefined ||
        patch.skip_bots !== undefined
      ) {
        const stored =
          patch.review_policy_json !== undefined
            ? patch.review_policy_json
            : (getRepo(fullName)?.review_policy_json ?? null);
        if (stored !== null && stored !== '"legacy"') {
          return errorResponse(
            409,
            "policy_in_use",
            "This repository uses a review policy, so the auto review, drafts and bots switches do not apply. Change the policy instead.",
          );
        }
        patch.review_policy_json = '"legacy"';
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
      if (typeof body.watchOpenIssues === "boolean") {
        patch.watch_open_issues = body.watchOpenIssues ? 1 : 0;
      }
      if (body.watchPushMode !== undefined) {
        if (
          body.watchPushMode !== "queue" &&
          body.watchPushMode !== "cancel-and-merge"
        ) {
          return errorResponse(
            422,
            "invalid_watch_push_mode",
            "watchPushMode must be queue or cancel-and-merge.",
          );
        }
        patch.watch_push_mode = body.watchPushMode;
      }
      updateRepoSettings(fullName, patch);
      // Blank (null) clears the value so the account default applies again,
      // as the form's hint promises. Anything else must be a positive whole
      // number, the same rule the account defaults follow.
      const init: Record<string, number | undefined> = {};
      for (const key of [
        "maxPrMonths",
        "maxCommits",
        "maxPullRequestChangeLines",
        "maxComments",
      ] as const) {
        if (!(key in body)) continue;
        const raw = body[key];
        if (raw === null || raw === "") {
          init[key] = undefined;
        } else if (
          typeof raw === "number" &&
          Number.isInteger(raw) &&
          raw > 0
        ) {
          init[key] = raw;
        } else {
          return errorResponse(
            422,
            "invalid_knowledge_limit",
            `${key} must be a positive whole number, or blank for the account default`,
          );
        }
      }
      // The repository's own AI and models. Blank clears them, so the
      // repository inherits the global values again.
      const aiPatch: RepoConfig = {};
      for (const key of ["ai", "lowModel", "highModel"] as const) {
        if (!(key in body)) continue;
        const raw = body[key];
        if (raw === null || (typeof raw === "string" && raw.trim() === "")) {
          aiPatch[key] = undefined;
          continue;
        }
        if (typeof raw !== "string") {
          return errorResponse(
            422,
            `invalid_${key}`,
            `${key} must be text or null`,
          );
        }
        if (
          key === "ai" &&
          !(AI_PROVIDERS as readonly string[]).includes(raw.trim())
        ) {
          return errorResponse(
            422,
            "invalid_ai",
            `ai must be one of: ${AI_PROVIDERS.join(", ")}`,
          );
        }
        (aiPatch as Record<string, unknown>)[key] = raw.trim();
      }
      // The review settings `set --repo` wrote before the dashboard had a
      // field for them. The same checks, so the two sides accept the same
      // values.
      const toolPatch: RepoConfig = {};
      if (
        "diagramRuntime" in body ||
        "plantumlServer" in body ||
        "plantumlOutputFormat" in body
      ) {
        const value = (key: string) => {
          const raw = body[key];
          return typeof raw === "string" && raw.trim() !== ""
            ? raw.trim()
            : undefined;
        };
        try {
          const diagram = diagramOptionsFrom({
            runtime: value("diagramRuntime"),
            server: value("plantumlServer"),
            format: value("plantumlOutputFormat"),
          });
          toolPatch.diagramRuntime = diagram.diagramRuntime;
          toolPatch.plantumlServer = diagram.plantumlServer;
          toolPatch.plantumlOutputFormat = diagram.plantumlOutputFormat;
        } catch (error) {
          if (error instanceof DiagramSettingError) {
            return errorResponse(
              422,
              "invalid_diagram",
              error.message.replace(
                /--diagram-runtime|--plantuml-server|--plantuml-output-format/,
                (flag) => flag.slice(2),
              ),
            );
          }
          throw error;
        }
      }
      if ("reviewReferences" in body) {
        const raw = body.reviewReferences;
        if (raw === null) toolPatch.reviewReferences = undefined;
        else if (typeof raw === "boolean") toolPatch.reviewReferences = raw;
        else {
          return errorResponse(
            422,
            "invalid_review_references",
            "reviewReferences must be true, false or null",
          );
        }
      }
      if ("mcpAllowForks" in body) {
        const raw = body.mcpAllowForks;
        if (raw === null) toolPatch.mcpAllowForks = undefined;
        else if (typeof raw === "boolean") toolPatch.mcpAllowForks = raw;
        else {
          return errorResponse(
            422,
            "invalid_mcp_allow_forks",
            "mcpAllowForks must be true, false or null",
          );
        }
      }
      if ("companions" in body) {
        const raw = body.companions;
        if (raw === null || raw === "") {
          toolPatch.companions = undefined;
        } else if (typeof raw === "string") {
          try {
            toolPatch.companions = parseCompanionsSetting(raw, fullName);
          } catch (error) {
            return errorResponse(
              422,
              "invalid_companions",
              error instanceof Error ? error.message : String(error),
            );
          }
        } else {
          return errorResponse(
            422,
            "invalid_companions",
            "companions must be text or null",
          );
        }
      }
      for (const [key, min] of [
        ["reviewReadDiffMaxChars", -1],
        ["reviewToolResultMaxChars", -1],
        ["reviewToolBudgetChars", -1],
        ["reviewSearchMaxContextLines", -1],
        ["reviewDiffMaxChars", -1],
        ["reviewFilePatchMaxChars", -1],
        ["guideFullEvery", 0],
      ] as const) {
        if (!(key in body)) continue;
        const raw = body[key];
        if (raw === null || raw === "") {
          toolPatch[key] = undefined;
        } else if (
          typeof raw === "number" &&
          Number.isInteger(raw) &&
          raw >= min
        ) {
          toolPatch[key] = raw;
        } else {
          return errorResponse(
            422,
            `invalid_${key}`,
            key === "guideFullEvery"
              ? "guideFullEvery must be a whole number: 1 always rewrites the guide, 0 never does after init"
              : `${key} must be a whole number (0 or -1 for no limit), or blank`,
          );
        }
      }
      const repoPatch: RepoConfig = {
        ...toolPatch,
        ...init,
        ...cronPatch,
        ...promptPatch,
        ...speedPatch,
        ...blockingPatch,
        ...aiPatch,
      };
      if (Object.keys(repoPatch).length > 0) {
        await writeRepoConfig(fullName, repoPatch);
      }
      const changes = settingChanges(before, repoSnapshot(fullName));
      if (changes.length > 0) {
        audit("repo-settings", "Changed repository settings", {
          target: fullName,
          changes,
        });
      }
      return Response.json({ ok: true });
    }
    if (!sub && request.method === "DELETE") {
      requireActiveRepo(fullName);
      deactivateRepo(fullName);
      audit("repo", "Removed a repository", { target: fullName });
      return Response.json({ ok: true });
    }
    // A repository back in the App's installation stays off until this.
    // Knowledge that is still on disk is kept, so no init runs: the
    // Knowledge page then shows what changed since and the usual Sync.
    if (sub === "resume" && request.method === "POST") {
      const row = getRepo(fullName);
      if (!row) return errorResponse(404, "not_found", "no such repository");
      if (row.active === 1 || !row.returned_at) {
        return errorResponse(
          409,
          "not_returned",
          "This repository is not waiting to be resumed.",
        );
      }
      // Guides deleted from disk meanwhile: say so, rather than claim
      // knowledge that is gone. Which guide files exist depends on what init
      // found, so only a missing folder counts.
      if (row.knowledge_built_at && !existsSync(`${reposDir()}/${fullName}`)) {
        clearRepoKnowledge(fullName);
      }
      if (!resumeRepo(fullName)) {
        return errorResponse(
          409,
          "not_returned",
          "This repository is not waiting to be resumed.",
        );
      }
      audit("repo", "Resumed reviews on a repository", { target: fullName });
      return Response.json({ ok: true });
    }
    if (sub === "remake" && request.method === "POST") {
      const { id } = enqueueSetup(fullName, "remake");
      return Response.json({ jobId: id });
    }
    if (sub === "knowledge" && request.method === "GET") {
      return Response.json(await repoKnowledge(fullName));
    }
    if (sub === "knowledge" && request.method === "DELETE") {
      requireActiveRepo(fullName);
      return await clearOneRepo(fullName, url);
    }
    if (
      sub === "pulls" &&
      pr &&
      action === "review" &&
      request.method === "POST"
    ) {
      requireActiveRepo(fullName);
      // An optional `{ model }` pins the review to the model a failed one
      // used. No body, or no model, keeps the configured model.
      let body: { model?: unknown } = {};
      try {
        const raw = await request.text();
        if (raw.trim()) body = JSON.parse(raw);
      } catch {
        return errorResponse(400, "bad_request", "expected a JSON body");
      }
      if (
        body.model !== undefined &&
        (typeof body.model !== "string" ||
          body.model.length === 0 ||
          body.model.length > 200)
      ) {
        return errorResponse(
          422,
          "invalid_setting",
          "model must be a model id of 1 to 200 characters",
        );
      }
      const { id } = enqueueManualReview(fullName, pr, {
        model: body.model as string | undefined,
      });
      audit("review", `Started a review of #${pr}`, { target: fullName });
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
