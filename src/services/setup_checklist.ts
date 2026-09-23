/** The "Finish setup" checklist shown on the home page (CORE-75, C01/F26).
 *
 * Each item is derived from state that already exists, so the card reflects
 * what serve can actually do rather than a parallel bookkeeping of it. The
 * webhook item reuses CORE-71's reachability check. */
import { readConfig } from "../config.ts";
import { countReviews } from "../store/reviews.ts";
import { listRemoteTokens } from "../store/remote_tokens.ts";
import { listActiveRepos } from "../store/repos.ts";
import { lastDelivery } from "../store/deliveries.ts";
import { webhookReachabilityProblem } from "../util/webhook_reachability.ts";

export type SetupItem = {
  id: string;
  title: string;
  detail: string;
  done: boolean;
  /** Where the fix lives. In-page anchors on /settings where one exists. */
  href: string;
  linkLabel: string;
};

export function setupChecklist(webhookUrl: string): SetupItem[] {
  const config = readConfig();
  const aiDone = Boolean(config.ai && config.ai !== "none" && config.token);
  const appDone = Boolean(config.githubAppId && config.githubAppPrivateKey);
  const repoCount = listActiveRepos().length;
  const reviewCount = countReviews();
  const tokenCount = listRemoteTokens().length;
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
      href: "/settings#ai",
      linkLabel: "Open models",
    },
    {
      id: "app",
      title: "GitHub App",
      detail: appDone
        ? "The App is configured."
        : "Create and install the App so reviews can be posted to pull requests.",
      done: appDone,
      href: "/settings#github",
      linkLabel: "Open GitHub",
    },
    {
      id: "webhook",
      title: "Webhook reachable",
      detail: !appDone
        ? "Set up the GitHub App first, then point its webhook at this server."
        : reached
          ? "GitHub has delivered a webhook to this server."
          : reach
            ? `GitHub cannot reach ${webhookUrl}. ${reach}`
            : "Waiting for the first delivery. Open a pull request to confirm.",
      done: reached,
      href: "/settings#github",
      linkLabel: "Open webhook",
    },
    {
      id: "repo",
      title: "First repository",
      detail:
        repoCount === 0
          ? "Add a repository to generate its guides."
          : `${repoCount} ${repoCount === 1 ? "repository" : "repositories"} added.`,
      done: repoCount > 0,
      href: "/repos/new",
      linkLabel: "Add repository",
    },
    {
      id: "review",
      title: "First review",
      detail:
        reviewCount === 0
          ? "A review appears after the first pull request, or run one by number."
          : `${reviewCount} ${reviewCount === 1 ? "review" : "reviews"} so far.`,
      done: reviewCount > 0,
      href: "/activity",
      linkLabel: "Open activity",
    },
    {
      id: "cli",
      title: "CLI connected",
      detail:
        tokenCount === 0
          ? "Create a remote token to run co-maintainer review --remote."
          : `${tokenCount} remote ${tokenCount === 1 ? "token" : "tokens"} created.`,
      done: tokenCount > 0,
      href: "/settings#remote",
      linkLabel: "Open tokens",
    },
  ];
}
