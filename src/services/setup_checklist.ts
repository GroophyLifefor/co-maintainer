/** The four required setup steps, shared by the home banner and /setup.
 *
 * Each item is derived from state that already exists, so the count reflects
 * what serve can actually do rather than a parallel bookkeeping of it. One
 * list feeds every page, so home and /setup can never disagree on "n of 4".
 * Optional extras (first review, remote token) stay out of the count. The
 * webhook part of the App step reuses the existing reachability check. */
import { aiConfigured, readConfig, resolveAppPrivateKey } from "../config.ts";
import { listActiveRepos } from "../store/repos.ts";
import { lastDelivery } from "../store/deliveries.ts";
import { webhookReachabilityProblem } from "../util/webhook_reachability.ts";

export type SetupItem = {
  id: string;
  title: string;
  detail: string;
  done: boolean;
  /** Where the fix lives. */
  href: string;
  linkLabel: string;
};

export function setupChecklist(webhookUrl: string): SetupItem[] {
  const config = readConfig();
  const aiDone = aiConfigured(config);
  const githubDone = Boolean(
    config.auth === "gh" || (config.auth === "pat" && config.githubPat),
  );
  const appDone = Boolean(config.githubAppId && resolveAppPrivateKey(config));
  const builtCount = listActiveRepos().filter(
    (repo) => repo.knowledge_built_at,
  ).length;
  const reach = webhookReachabilityProblem(webhookUrl);
  const reached = reach === undefined && lastDelivery() !== undefined;

  return [
    {
      id: "ai",
      title: "Models and API key",
      detail: aiDone
        ? "An AI provider and key are saved."
        : "Add a provider and API key so reviews and guides can be written.",
      done: aiDone,
      href: "/settings/ai",
      linkLabel: "Open models",
    },
    {
      id: "github",
      title: "GitHub access",
      detail: githubDone
        ? "GitHub access is configured."
        : "Use gh or a personal access token.",
      done: githubDone,
      href: "/settings/github",
      linkLabel: "Open GitHub",
    },
    {
      id: "app",
      title: "GitHub App and webhook",
      detail: !appDone
        ? "Create and install the App so reviews can be posted to pull requests."
        : reached
          ? "GitHub has delivered a webhook to this server."
          : reach
            ? `GitHub cannot reach ${webhookUrl}. ${reach}`
            : "Waiting for the first delivery. Open a pull request to confirm.",
      done: appDone && reached,
      href: "/settings/github",
      linkLabel: "Open App",
    },
    {
      id: "repo",
      title: "First repository",
      detail:
        builtCount === 0
          ? "Add a repository and generate its guides."
          : `${builtCount} ${builtCount === 1 ? "repository has" : "repositories have"} guides.`,
      done: builtCount > 0,
      href: "/repos/new",
      linkLabel: "Add repository",
    },
  ];
}
