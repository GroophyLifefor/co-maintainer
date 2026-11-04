/** What the Ctrl K palette searches: fixed pages and actions, plus real
 * repositories and pull requests from the database. Nothing is invented: a
 * query with no matching record returns no group for it. */
import { getAppDb } from "../store/app_db.ts";
import { listActiveRepos } from "../store/repos.ts";

export type SearchItem = {
  label: string;
  href: string;
  icon: string;
  hint?: string;
};
export type SearchResult = { groups: { label: string; items: SearchItem[] }[] };

const PAGES: SearchItem[] = [
  { label: "Repositories", href: "/", icon: "layout-grid" },
  { label: "Activity", href: "/activity", icon: "activity" },
  { label: "Usage", href: "/usage", icon: "chart-no-axes-column" },
  { label: "Setup", href: "/setup", icon: "list-checks" },
  { label: "AI models", href: "/settings/ai", icon: "sparkles" },
  { label: "GitHub", href: "/settings/github", icon: "github" },
  {
    label: "Review defaults",
    href: "/settings/defaults",
    icon: "sliders-horizontal",
  },
  { label: "Remote access", href: "/settings/remote", icon: "key-round" },
  { label: "Server", href: "/settings/server", icon: "server" },
  { label: "Sign-in", href: "/settings/sign-in", icon: "shield-check" },
  { label: "Danger zone", href: "/settings/danger", icon: "triangle-alert" },
];

const ACTIONS: SearchItem[] = [
  { label: "Add repository", href: "/repos/new", icon: "plus" },
  {
    label: "Create a remote token",
    href: "/settings/remote",
    icon: "key-round",
  },
  { label: "Change AI model", href: "/settings/ai", icon: "sparkles" },
];

const LIMIT = 8;

export function searchAll(query: string): SearchResult {
  const q = query.trim().toLowerCase();
  const matches = (label: string) => !q || label.toLowerCase().includes(q);

  const repos = listActiveRepos()
    .filter((repo) => matches(repo.full_name))
    .slice(0, LIMIT)
    .map((repo) => ({
      label: repo.full_name,
      href: `/repos/${repo.full_name}`,
      icon: "git-branch",
    }));

  // One result per pull request of an active repository, newest first. The
  // label "repo #7" is what the query is matched against, so "#7", "7" and
  // the repository name all find it.
  const pulls = getAppDb()
    .prepare<{ repo: string; pr_number: number }>(
      `SELECT r.repo, r.pr_number, MAX(r.created_at) AS last
       FROM reviews r JOIN repos p ON p.full_name = r.repo AND p.active = 1
       WHERE r.kind = 'pr'
       GROUP BY r.repo, r.pr_number
       ORDER BY last DESC`,
    )
    .all()
    .map((row) => ({
      label: `${row.repo} #${row.pr_number}`,
      href: `/repos/${row.repo}/pulls/${row.pr_number}`,
      icon: "git-pull-request",
    }))
    .filter((item) => matches(item.label))
    .slice(0, LIMIT);

  return {
    groups: [
      { label: "Pages", items: PAGES.filter((item) => matches(item.label)) },
      { label: "Repositories", items: repos },
      { label: "Pull requests", items: pulls },
      {
        label: "Actions",
        items: ACTIONS.filter((item) => matches(item.label)),
      },
    ].filter((group) => group.items.length > 0),
  };
}
