import type { GitHubClient, Json, Options } from "../types.ts";
import {
  guideRebuiltSince,
  type ResolvedFinding,
} from "../review/carry_over.ts";
import { loadGuides } from "../review/guides.ts";
import { githubPullRequestToRevision } from "../pr/github_revision.ts";
import type { Revision } from "../review/revision.ts";
import type { ReviewExtras } from "../pr/reviewer.ts";
import {
  clearPrCarry,
  prSubjectId,
  savePrCarry,
  tryLoadPrCarry,
} from "../local/carry_over_store.ts";
import {
  finishCarryRun,
  startCarryRun,
  storedFindings,
  type CarryRun,
} from "./review_carry.ts";
import type { ReviewWarning } from "./review_result.ts";

type EngineAnswer = {
  text: string;
  visiblePaths: string[];
  guideBuiltAt: string | null;
};

/** What a CLI pull request review needs around the engine call. `extras` goes
 * to `reviewPullRequest` as it is, `finish` turns its answer into findings and
 * stores them for the next run. `warnings` is read after `finish`. */
export type PrCarry = {
  extras: ReviewExtras;
  warnings: ReviewWarning[];
  finish(response: EngineAnswer): Promise<ResolvedFinding[]>;
};

/** True when `head` is the last reviewed head or was pushed on top of it. A
 * force-push leaves the old head out of the new history, and then the stored
 * findings point at code that no longer exists. Any doubt counts as a
 * force-push, because starting fresh costs one scan and a wrong match hides a
 * real finding. */
/** Null when the stored run may be used, otherwise the reason it may not. */
async function whyNotContained(
  client: GitHubClient,
  repo: string,
  last: string | null | undefined,
  head: string,
): Promise<string | null> {
  if (!last) return "the last run did not record its head";
  if (!head) return "GitHub gave no head for this pull request";
  if (last === head) return null;
  try {
    const compare = await client.request<Json>(
      `repos/${repo}/compare/${last}...${head}?per_page=1`,
    );
    if (compare.status === "ahead" || compare.status === "identical") {
      return null;
    }
    return `the head does not contain the last reviewed head (${String(compare.status)})`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `could not compare the heads (${reason})`;
  }
}

/** Loads what the last run of this pull request left, decides whether it may
 * be used, and builds the carry-over the engine takes. The decision mirrors
 * local review, plus the force-push check: `--fresh`, a guide rebuilt since
 * the last run, and a head that no longer contains the last reviewed head each
 * start fresh. A cache or GitHub problem never fails the review. It only means
 * nothing is carried, and the run says so in a warning. */
export async function startPrCarry(
  client: GitHubClient,
  options: Options,
  fresh: boolean,
  log: (message: string) => void = () => {},
): Promise<PrCarry> {
  const repo = options.repo;
  const prNumber = options.prNumber!;
  const warnings: ReviewWarning[] = [];
  const forget = async () => {
    await clearPrCarry(repo, prNumber).catch(() => {});
  };

  if (fresh) await forget();

  let current: Revision;
  let headSha: string;
  try {
    const [pr, files] = await Promise.all([
      client.request<Json>(`repos/${repo}/pulls/${prNumber}`),
      client.pages<Json>(`repos/${repo}/pulls/${prNumber}/files`),
    ]);
    headSha = String((pr.head as Json | undefined)?.sha ?? "");
    const baseLabel = `origin/${String((pr.base as Json | undefined)?.ref ?? "main")}`;
    current = githubPullRequestToRevision(files, pr, baseLabel);
  } catch {
    // The review reads the same pull request and reports a real failure.
    // Without the file list there is nothing to match findings against.
    warnings.push({
      code: "carry_over_unavailable",
      message:
        "Could not read the pull request files for carry-over. Continuing without prior findings.",
    });
    return {
      extras: {},
      warnings,
      finish: async (response) =>
        finishCarryRun(
          { previous: null, items: [], extras: {} },
          {
            files: [],
            title: "",
            description: "",
            baseLabel: "",
            producer: "github",
          },
          response,
        ).resolved,
    };
  }

  const guides = await loadGuides(repo);
  const loaded = await tryLoadPrCarry(repo, prNumber);
  if (loaded.unavailable) {
    warnings.push({
      code: "carry_over_unavailable",
      message:
        "Could not read the carry-over cache. Continuing without prior findings.",
    });
  }
  let previous = loaded.data;
  if (
    previous &&
    guideRebuiltSince(previous.guideBuiltAt, guides.guideBuiltAt)
  ) {
    log("the guide was rebuilt since the last review, starting fresh");
    await forget();
    previous = null;
  }
  if (previous) {
    const why = await whyNotContained(client, repo, previous.headSha, headSha);
    if (why) {
      log(`${why}, starting fresh`);
      await forget();
      previous = null;
    }
  }

  const run: CarryRun = startCarryRun(previous, current, guides.guideBuiltAt);
  return {
    extras: { ...run.extras },
    warnings,
    finish: async (response) => {
      const { resolved, visiblePaths } = finishCarryRun(run, current, response);
      try {
        await savePrCarry({
          subjectId: prSubjectId(repo, prNumber),
          files: current.files,
          visiblePaths: [...visiblePaths],
          findings: storedFindings(resolved),
          guideBuiltAt: response.guideBuiltAt,
          headSha,
        });
      } catch {
        warnings.push({
          code: "carry_over_unavailable",
          message: "Could not save carry-over state for the next review.",
        });
      }
      return resolved;
    },
  };
}
