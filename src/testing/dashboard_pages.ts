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

/** A JSON call to the dashboard API as the signed-in user. */
export type ApiSend = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; json: Record<string, unknown> }>;

export async function withDashboard(
  fn: (get: PageGet, send: ApiSend) => Promise<void>,
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
      await fn(
        async (path) => {
          const response = await app.fetch(
            new Request(`http://localhost${path}`, {
              headers: { cookie: `cm=${token}` },
            }),
          );
          return { status: response.status, html: await response.text() };
        },
        async (method, path, body) => {
          const response = await app.fetch(
            new Request(`http://localhost${path}`, {
              method,
              headers: {
                cookie: `cm=${token}`,
                "content-type": "application/json",
                "x-requested-with": "co-maintainer",
              },
              body: body === undefined ? undefined : JSON.stringify(body),
            }),
          );
          const textBody = await response.text();
          let json: Record<string, unknown> = {};
          try {
            json = textBody ? JSON.parse(textBody) : {};
          } catch {
            json = { text: textBody };
          }
          return { status: response.status, json };
        },
      );
    } finally {
      closeAppDb();
    }
  });
}
