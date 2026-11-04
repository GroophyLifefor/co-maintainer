import { filterRepoList, repoState } from "./repo_list.ts";
import type { RepoListItem } from "./dashboard.ts";
import type { JobRow, RepoRow } from "../store/rows.ts";
import { test } from "node:test";

function item(
  fullName: string,
  repo: Partial<RepoRow> = {},
  job?: Partial<JobRow>,
): RepoListItem {
  return {
    repo: {
      full_name: fullName,
      installation_id: 9,
      active: 1,
      auto_review: 1,
      review_scope: "all",
      skip_drafts: 1,
      skip_bots: 1,
      knowledge_built_at: "2026-11-01T00:00:00.000Z",
      knowledge_base_sha: "abc",
      settings: "{}",
      created_at: "2026-11-01T00:00:00.000Z",
      use_codegraph: 0,
      review_policy_json: null,
      ...repo,
    },
    drift: undefined,
    stats: {} as RepoListItem["stats"],
    latestJob: job ? ({ type: "init", status: "done", ...job } as JobRow) : undefined,
  } as RepoListItem;
}

test("a built repo with auto review and an App is Reviewing", () => {
  const state = repoState(item("a/b"), true);
  if (state !== "reviewing") throw new Error(state);
});

test("no App means Paused even with auto review on", () => {
  const state = repoState(item("a/b"), false);
  if (state !== "paused") throw new Error(state);
});

test("auto review off is Paused", () => {
  const state = repoState(item("a/b", { auto_review: 0 }), true);
  if (state !== "paused") throw new Error(state);
});

test("a repo whose knowledge is not built yet is not Reviewing", () => {
  const state = repoState(item("a/b", { knowledge_built_at: null }), true);
  if (state !== "paused") throw new Error(state);
});

test("a running or queued setup job is Setting up, not Reviewing", () => {
  for (const status of ["running", "queued"]) {
    const state = repoState(item("a/b", {}, { status }), true);
    if (state !== "setting-up") throw new Error(`${status}: ${state}`);
  }
});

test("a failed first setup is Setup failed", () => {
  const state = repoState(
    item("a/b", { knowledge_built_at: null }, { status: "failed" }),
    true,
  );
  if (state !== "setup-failed") throw new Error(state);
});

test("filters by status and by a case-insensitive name search", () => {
  const items = [
    item("acme/widgets"),
    item("acme/gadgets", { auto_review: 0 }),
    item("other/tools", {}, { status: "running" }),
  ];
  const names = (list: RepoListItem[]) =>
    list.map((i) => i.repo.full_name).join(",");
  const cases: [Parameters<typeof filterRepoList>[1], string][] = [
    [{}, "acme/widgets,acme/gadgets,other/tools"],
    [{ status: "all" }, "acme/widgets,acme/gadgets,other/tools"],
    [{ status: "reviewing" }, "acme/widgets"],
    // Paused lists everything that is not Reviewing.
    [{ status: "paused" }, "acme/gadgets,other/tools"],
    [{ q: "WIDG" }, "acme/widgets"],
    [{ q: "acme", status: "paused" }, "acme/gadgets"],
    [{ status: "bogus" }, "acme/widgets,acme/gadgets,other/tools"],
  ];
  for (const [opts, want] of cases) {
    const got = names(filterRepoList(items, opts, true));
    if (got !== want) throw new Error(`${JSON.stringify(opts)}: ${got}`);
  }
});
