/** What one side of the product can do, the other can do too, and a change
 * takes effect where a user expects it to: the dashboard and the CLI accept
 * and refuse the same values, sign-in changes apply without a restart, a
 * cleared value is kept out of sight, and repository settings and extensions
 * can be managed from both sides.
 *
 * No step needs the model: every check reads config.json, app.db, a page or
 * an API answer. */
import { check, defineFlow, type CheckResult, type Sim } from "../flow.ts";
import { APP_REPO, appRows, serveRepo } from "./app.ts";
import { INIT_AI } from "./init.ts";

const STEP = {
  served: "serve a repository with guides",
  signIn: "a sign-in change applies without a restart",
  credentials: "a changed allowed user signs old sessions out",
  clear: "a cleared value is kept out of sight",
  setRepoDb: "set --repo writes the dashboard's switches",
  repoTools: "the repository page writes the CLI's review settings",
  authCli: "set accepts both sign-in values and refuses a state with no way in",
  configSet: "config set writes every key config lists",
  pages: "pages show the new fields and the CLI names",
  extensions: "extensions are managed from the dashboard",
};

function json(body: unknown, method = "PUT"): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      "x-requested-with": "fetch",
    },
    body: JSON.stringify(body),
  };
}

async function settingsCall(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { handleSettingsRoute } =
    await import("../../../server/api/settings.ts");
  const { memoryPasswordStore } = await import("../../../server/auth.ts");
  const response = await handleSettingsRoute(
    new Request(`http://localhost${path}`, init),
    new URL(`http://localhost${path}`),
    "http://localhost:5000/github/webhook",
    memoryPasswordStore("sim-password-1234"),
    "127.0.0.1",
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function loginPage(): Promise<string> {
  const { handlePageRequest } = await import("../../../server/pages/router.ts");
  const { memoryPasswordStore } = await import("../../../server/auth.ts");
  const response = await handlePageRequest(
    new Request("http://localhost/login"),
    {
      passwordStore: memoryPasswordStore("sim-password-1234"),
      authOverrides: {},
    },
    "127.0.0.1",
  );
  return response ? await response.text() : "";
}

function repoConfig(sim: Sim): Record<string, unknown> {
  const repos = (sim.world.readConfig().repos ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  return repos[APP_REPO] ?? {};
}

function checks(sim: Sim): CheckResult[] {
  const state = sim.state as Record<string, Record<string, unknown>>;
  const signIn = state.signIn ?? {};
  const credentials = state.credentials ?? {};
  const clear = state.clear ?? {};
  const db = state.setRepoDb ?? {};
  const tools = state.repoTools ?? {};
  const authCli = state.authCli ?? {};
  const configSet = state.configSet ?? {};
  const pages = state.pages ?? {};
  const extensions = state.extensions ?? {};
  return [
    check(
      "turning GitHub sign-in on in config shows its button on the next login page, without a restart",
      signIn.before === false && signIn.after === true,
      `GitHub button before ${String(signIn.before)} · after ${String(signIn.after)}`,
    ),
    check(
      "a changed allowed user stamps credentialsChangedAt, an unchanged save does not",
      credentials.unchanged === undefined &&
        typeof credentials.changed === "string",
      `unchanged save ${String(credentials.unchanged)} · changed save ${String(credentials.changed)}`,
    ),
    check(
      "emptying the review model clears it and keeps the old value under clearedSettings only",
      clear.high === undefined &&
        clear.kept === "sim-model-to-clear" &&
        clear.shown === "",
      `highModel ${String(clear.high)} · kept ${String(clear.kept)} · shown "${String(clear.shown)}"`,
    ),
    check(
      "a saved key is removed with an explicit clear, an empty key field keeps it",
      clear.keyAfterEmpty === "sim-key-to-keep" &&
        clear.keyAfterClear === undefined,
      `after empty field ${clear.keyAfterEmpty ? "kept" : "gone"} · after clear ${clear.keyAfterClear ? "kept" : "gone"}`,
    ),
    check(
      "set --repo writes auto review, scope and codegraph into app.db next to the running server",
      db.auto === 0 && db.scope === "whole-pr" && db.codegraph === 1,
      JSON.stringify(db),
    ),
    check(
      "set --repo refuses a value the dashboard refuses",
      db.badExit !== 0,
      `exit ${String(db.badExit)}`,
    ),
    check(
      "the repository page saves companions, references, a tool limit and the diagram runtime to config.json",
      tools.status === 200 &&
        JSON.stringify(tools.companions) === JSON.stringify(["sim/other"]) &&
        tools.references === true &&
        tools.budget === 9000 &&
        tools.diagram === "plantuml",
      JSON.stringify(tools),
    ),
    check(
      "the repository page refuses a bad diagram runtime with 422",
      tools.badStatus === 422,
      `status ${String(tools.badStatus)}`,
    ),
    check(
      "set refuses to turn password sign-in off with no other way in, and --enable-auth=password turns it back on",
      authCli.noWayInExit !== 0 &&
        authCli.reEnabled === false &&
        authCli.disableGithubExit === 0,
      JSON.stringify(authCli),
    ),
    check(
      "config set writes max-concurrent-jobs and refuses a webhook URL serve would refuse",
      configSet.jobs === 4 && configSet.badWebhookExit !== 0,
      JSON.stringify(configSet),
    ),
    check(
      "the setup wizard points at the repository card that holds diagrams and references",
      pages.wizard === true,
      `hint found ${String(pages.wizard)}`,
    ),
    check(
      "Review defaults has the blocking rule, and the repository page names --max-comment",
      pages.blocking === true && pages.maxComment === true,
      `blocking field ${String(pages.blocking)} · --max-comment ${String(pages.maxComment)}`,
    ),
    check(
      "an extension is registered, disabled and removed from the dashboard, and a bad one is refused",
      extensions.registered === true &&
        extensions.disabled === true &&
        extensions.removed === true &&
        extensions.badStatus === 422,
      JSON.stringify(extensions),
    ),
  ];
}

export default defineFlow({
  name: "dashboard-parity",
  description:
    "the dashboard and the CLI reach the same settings, accept the same values, and sign-in changes apply without a restart",
  ai: INIT_AI,
  steps: [
    {
      name: STEP.served,
      async run(sim) {
        await serveRepo(sim);
        return `${APP_REPO} · guides built`;
      },
    },
    {
      name: STEP.signIn,
      async run(sim) {
        const before = (await loginPage()).includes("/auth/github");
        sim.world.writeConfig({
          githubAuthEnabled: true,
          githubOAuthClientId: "sim-client",
          githubOAuthClientSecret: "sim-client-secret",
          githubOAuthAllowedUser: "sim-owner",
        });
        sim.world.addSecret("OAuth client secret", "sim-client-secret");
        const after = (await loginPage()).includes("/auth/github");
        sim.state.signIn = { before, after };
        return `before ${before} · after ${after}`;
      },
    },
    {
      name: STEP.credentials,
      async run(sim) {
        await settingsCall(
          "/api/settings",
          json({ githubOAuthAllowedUser: "sim-owner" }),
        );
        const unchanged = sim.world.readConfig().credentialsChangedAt;
        await settingsCall(
          "/api/settings",
          json({ githubOAuthAllowedUser: "sim-other" }),
        );
        const changed = sim.world.readConfig().credentialsChangedAt;
        sim.state.credentials = { unchanged, changed };
        return `unchanged ${String(unchanged)} · changed ${String(changed)}`;
      },
    },
    {
      name: STEP.clear,
      async run(sim) {
        const before = sim.world.readConfig();
        sim.world.writeConfig({ highModel: "sim-model-to-clear" });
        await settingsCall("/api/settings", json({ highModel: "" }));
        const after = sim.world.readConfig();
        const kept = (
          after.clearedSettings as
            | Record<string, { value: unknown }>
            | undefined
        )?.highModel?.value;
        const shown = (await settingsCall("/api/settings")).body.highModel;
        sim.world.addSecret("key to keep", "sim-key-to-keep");
        sim.world.writeConfig({ token: "sim-key-to-keep" });
        await settingsCall("/api/settings", json({ token: "" }));
        const keyAfterEmpty = sim.world.readConfig().token;
        await settingsCall("/api/settings", json({ clear: ["token"] }));
        const keyAfterClear = sim.world.readConfig().token;
        sim.world.writeConfig({
          highModel: before.highModel,
          token: before.token,
        });
        sim.state.clear = {
          high: after.highModel,
          kept,
          shown,
          keyAfterEmpty,
          keyAfterClear,
        };
        return `cleared ${String(after.highModel)} · kept ${String(kept)}`;
      },
    },
    {
      name: STEP.setRepoDb,
      async run(sim) {
        await sim.cli([
          "set",
          `--repo=${APP_REPO}`,
          "--auto-review=off",
          "--review-scope=whole-pr",
          "--codegraph=on",
        ]);
        const row = appRows<{
          auto_review: number;
          review_scope: string;
          use_codegraph: number;
        }>(
          sim,
          "SELECT auto_review, review_scope, use_codegraph FROM repos WHERE full_name = ?",
          APP_REPO,
        )[0];
        const bad = await sim.cli([
          "set",
          `--repo=${APP_REPO}`,
          "--review-scope=everything",
        ]);
        sim.state.setRepoDb = {
          auto: row?.auto_review,
          scope: row?.review_scope,
          codegraph: row?.use_codegraph,
          badExit: bad.exitCode,
        };
        return JSON.stringify(sim.state.setRepoDb);
      },
    },
    {
      name: STEP.repoTools,
      async run(sim) {
        const { handleReposRoute } =
          await import("../../../server/api/repos.ts");
        const patch = async (body: unknown) => {
          const path = `/api/repos/${APP_REPO}`;
          const response = await handleReposRoute(
            new Request(`http://localhost${path}`, json(body, "PATCH")),
            new URL(`http://localhost${path}`),
          );
          return response?.status ?? 0;
        };
        const status = await patch({
          companions: "sim/other",
          reviewReferences: true,
          reviewToolBudgetChars: 9000,
          diagramRuntime: "plantuml",
        });
        const after = repoConfig(sim);
        const badStatus = await patch({ diagramRuntime: "graphviz" });
        sim.state.repoTools = {
          status,
          companions: after.companions,
          references: after.reviewReferences,
          budget: after.reviewToolBudgetChars,
          diagram: after.diagramRuntime,
          badStatus,
        };
        return JSON.stringify(sim.state.repoTools);
      },
    },
    {
      name: STEP.authCli,
      async run(sim) {
        sim.world.writeConfig({ githubAuthEnabled: false });
        const noWayIn = await sim.cli(["set", "--disable-auth=password"]);
        sim.world.writeConfig({
          passwordAuthDisabled: true,
          githubAuthEnabled: true,
        });
        await sim.cli(["set", "--enable-auth=password"]);
        const reEnabled = sim.world.readConfig().passwordAuthDisabled;
        const disableGithub = await sim.cli(["set", "--disable-auth=github"]);
        sim.state.authCli = {
          noWayInExit: noWayIn.exitCode,
          reEnabled,
          disableGithubExit: disableGithub.exitCode,
        };
        return JSON.stringify(sim.state.authCli);
      },
    },
    {
      name: STEP.configSet,
      async run(sim) {
        await sim.cli(["config", "set", "max-concurrent-jobs", "4"]);
        const jobs = sim.world.readConfig().maxConcurrentJobs;
        const bad = await sim.cli([
          "config",
          "set",
          "webhook-url",
          "https://example.com",
        ]);
        sim.state.configSet = { jobs, badWebhookExit: bad.exitCode };
        return JSON.stringify(sim.state.configSet);
      },
    },
    {
      name: STEP.pages,
      async run(sim) {
        const { renderSetup } = await import("../../../server/pages/setup.ts");
        const { renderSettingsPage } =
          await import("../../../server/pages/settings.ts");
        const { renderRepoSettings } =
          await import("../../../server/pages/repo_settings.ts");
        const { getRepo } = await import("../../../store/repos.ts");
        const { readConfig } = await import("../../../config.ts");
        const wizard = await renderSetup("sim", [], { step: "look" }).text();
        const defaults =
          (await renderSettingsPage(
            "sim",
            readConfig(),
            "",
            "http://localhost",
            "defaults",
          )?.text()) ?? "";
        const repoPage = await renderRepoSettings(
          "sim",
          getRepo(APP_REPO)!,
          repoConfig(sim),
        ).text();
        sim.state.pages = {
          wizard: wizard.includes("Review tools and limits"),
          blocking: defaults.includes('id="def-blocking"'),
          maxComment: repoPage.includes("--max-comment="),
        };
        return JSON.stringify(sim.state.pages);
      },
    },
    {
      name: STEP.extensions,
      async run(sim) {
        const { handleExtensionsRoute } =
          await import("../../../server/api/extensions.ts");
        const call = async (path: string, init?: RequestInit) =>
          (
            await handleExtensionsRoute(
              new Request(`http://localhost${path}`, init),
              new URL(`http://localhost${path}`),
            )
          )?.status ?? 0;
        const names = () =>
          (sim.world.readConfig().extensions ?? []) as {
            name: string;
            disabled?: boolean;
          }[];
        await call(
          "/api/extensions",
          json({ name: "sim-check", command: "echo {{details_path}}" }, "POST"),
        );
        const registered = names().some((entry) => entry.name === "sim-check");
        await call(
          "/api/extensions/sim-check",
          json({ disabled: true }, "PATCH"),
        );
        const disabled =
          names().find((entry) => entry.name === "sim-check")?.disabled ===
          true;
        await call("/api/extensions/sim-check", { method: "DELETE" });
        const removed = !names().some((entry) => entry.name === "sim-check");
        const badStatus = await call(
          "/api/extensions",
          json({ name: "bad", command: "echo {{nope}}" }, "POST"),
        );
        sim.state.extensions = { registered, disabled, removed, badStatus };
        return JSON.stringify(sim.state.extensions);
      },
    },
  ],
  checks,
});
