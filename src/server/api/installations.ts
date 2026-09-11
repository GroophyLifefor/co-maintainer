import { errorResponse } from "../errors.ts";
import { listInstallationsWithRepos } from "../../github/app.ts";
import { getRepo } from "../../store/repos.ts";

export async function handleInstallationsRoute(
  request: Request,
  githubApp: { appId: string; privateKeyPem: string } | undefined,
): Promise<Response> {
  if (request.method !== "GET") {
    return errorResponse(404, "not_found", "no route for /api/installations");
  }
  if (!githubApp) {
    return errorResponse(
      422,
      "app_not_configured",
      "GitHub App is not configured; run: co-maintainer set --github-app-id=... --github-app-private-key=...",
    );
  }
  const installations = await listInstallationsWithRepos(
    githubApp.appId,
    githubApp.privateKeyPem,
  );
  return Response.json({
    items: installations.map(({ installation, repos }) => ({
      id: installation.id,
      accountLogin: installation.account?.login ?? "",
      suspended: installation.suspended_at !== null,
      repos: repos.map((repo) => ({
        fullName: repo.fullName,
        private: repo.private,
        alreadyActive: Boolean(getRepo(repo.fullName)?.active),
      })),
    })),
  });
}
