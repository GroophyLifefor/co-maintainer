/** The Pull requests tab asked GitHub three things on every visit: which
 * installation sees the repository, a token for it, and the open pull
 * requests. The token is already cached in `app.ts` until shortly before it
 * expires. This module keeps the installation id per repository and the open
 * list for a minute, so a second visit makes no GitHub call at all. */
import { findInstallationForRepo, listOpenPullsVia } from "./app.ts";
import type { OpenPull } from "./app.ts";

/** How long an open pull request list is reused. */
export const OPEN_PULLS_TTL_MS = 60_000;

/** An installation id rarely changes. A failed list call drops it, so a
 * reinstalled App is found again on the next visit. */
const installationIds = new Map<string, number>();
const openLists = new Map<
  string,
  { pulls: OpenPull[] | undefined; at: number }
>();

function key(appId: string, fullName: string): string {
  return `${appId}\n${fullName.toLowerCase()}`;
}

/** Open, non-draft pull requests, or `undefined` when no installation of the
 * App covers the repository. Both answers are kept for a minute. */
export async function cachedOpenPulls(
  appId: string,
  privateKeyPem: string,
  fullName: string,
  now: () => number = Date.now,
): Promise<OpenPull[] | undefined> {
  const id = key(appId, fullName);
  const cached = openLists.get(id);
  if (cached && now() - cached.at < OPEN_PULLS_TTL_MS) return cached.pulls;
  let installationId = installationIds.get(id);
  if (installationId === undefined) {
    installationId = await findInstallationForRepo(
      appId,
      privateKeyPem,
      fullName,
    );
    if (installationId !== undefined) installationIds.set(id, installationId);
  }
  let pulls: OpenPull[] | undefined;
  if (installationId !== undefined) {
    try {
      pulls = await listOpenPullsVia(
        appId,
        privateKeyPem,
        installationId,
        fullName,
      );
    } catch (error) {
      installationIds.delete(id);
      throw error;
    }
  }
  openLists.set(id, { pulls, at: now() });
  return pulls;
}

/** The title of an open pull request from a list fetched in the last minute,
 * without asking GitHub. */
export function cachedOpenPullTitle(
  fullName: string,
  prNumber: number,
): string | undefined {
  const suffix = `\n${fullName.toLowerCase()}`;
  for (const [id, entry] of openLists) {
    if (!id.endsWith(suffix)) continue;
    const pull = entry.pulls?.find((item) => item.number === prNumber);
    if (pull?.title) return pull.title;
  }
  return undefined;
}

/** Tests only: forget every cached answer. */
export function clearOpenPullsCache(): void {
  installationIds.clear();
  openLists.clear();
}
