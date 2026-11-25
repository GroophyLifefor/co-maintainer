import { AppClient, findInstallationForRepo } from "../github/app.ts";
import { readConfig, resolveAppPrivateKey } from "../config.ts";
import { getRepo, setInstallationId } from "../store/repos.ts";
import type { GitHubClient } from "../types.ts";

/** A GitHub client that acts as the App on one installation. Review jobs and
 * the init, sync and remake jobs `serve` runs both read and write through it,
 * so a server with the App needs no `gh` login and no PAT. */
export function clientFor(installationId: number): GitHubClient {
  const config = readConfig();
  const privateKeyPem = resolveAppPrivateKey(config);
  if (!config.githubAppId || !privateKeyPem) {
    throw new Error("this job needs the GitHub App configured");
  }
  return new AppClient(config.githubAppId, privateKeyPem, installationId);
}

export async function resolveInstallationId(
  fullName: string,
): Promise<number | undefined> {
  const current = getRepo(fullName)?.installation_id;
  if (current) return current;
  const config = readConfig();
  const privateKeyPem = resolveAppPrivateKey(config);
  if (!config.githubAppId || !privateKeyPem) return undefined;
  const installationId = await findInstallationForRepo(
    config.githubAppId,
    privateKeyPem,
    fullName,
  );
  if (installationId !== undefined) setInstallationId(fullName, installationId);
  return installationId;
}
