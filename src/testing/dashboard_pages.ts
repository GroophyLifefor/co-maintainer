/** Shared by tests only. Runs `fn` against a dashboard app in an isolated
 * home with an open app.db, signed in, so a page test reads one route with
 * `get` and never touches the real config or database. */
import { createApp } from "../server/app.ts";
import { closeAppDb, openAppDb } from "../store/app_db.ts";
import { writeUserConfig } from "../config.ts";
import { withIsolatedHome } from "./isolated_home.ts";

const PASSWORD = "dashboard-page-test";

export type PageGet = (path: string) => Promise<{
  status: number;
  html: string;
}>;

export async function withDashboard(
  fn: (get: PageGet) => Promise<void>,
  config: Record<string, unknown> = {},
): Promise<void> {
  await withIsolatedHome(async () => {
    await openAppDb();
    try {
      await writeUserConfig({ auth: "gh", ai: "none", ...config });
      const app = createApp({ password: PASSWORD });
      const login = await app.fetch(
        new Request("http://localhost/login", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: `password=${PASSWORD}&next=/`,
          redirect: "manual",
        }),
      );
      const token = (login.headers.get("set-cookie") ?? "").match(
        /^cm=([^;]+)/,
      )?.[1];
      if (!token) throw new Error(`sign-in failed: ${login.status}`);
      await fn(async (path) => {
        const response = await app.fetch(
          new Request(`http://localhost${path}`, {
            headers: { cookie: `cm=${token}` },
          }),
        );
        return { status: response.status, html: await response.text() };
      });
    } finally {
      closeAppDb();
    }
  });
}
