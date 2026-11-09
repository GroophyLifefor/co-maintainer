/** Who may steer co-maintainer from a comment. A webhook's
 * author_association is only a first filter: MEMBER means a member of the
 * organization and COLLABORATOR may be read-only, so the repository
 * permission is asked from GitHub. */
import type { GitHubClient, Json } from "../types.ts";

/** True when `login` can write to `repo`. Any error counts as no. */
export async function hasWriteAccess(
  client: GitHubClient,
  repo: string,
  login: string | null | undefined,
): Promise<boolean> {
  if (!login) return false;
  try {
    const result = await client.request<Json>(
      `repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    return ["admin", "maintain", "write"].includes(
      String(result.role_name ?? result.permission ?? ""),
    );
  } catch {
    return false;
  }
}
