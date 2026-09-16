import { createApp } from "./app.ts";
import { closeAppDb, openAppDb } from "../store/app_db.ts";

const PASSWORD = "correct-horse";

async function withTempDb(fn: () => Promise<void>): Promise<void> {
  const original = Deno.env.get("CM_APP_DB");
  Deno.env.set("CM_APP_DB", `${Deno.makeTempDirSync()}/app.db`);
  try {
    await openAppDb();
    await fn();
  } finally {
    await closeAppDb();
    if (original === undefined) Deno.env.delete("CM_APP_DB");
    else Deno.env.set("CM_APP_DB", original);
  }
}

function postJson(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function withCsrf(headers: Record<string, string> = {}) {
  return { "x-requested-with": "co-maintainer", ...headers };
}

Deno.test("GET /api/health reports ok and a version, no auth needed", async () => {
  const app = createApp({ password: PASSWORD });
  const response = await app.fetch(
    new Request("http://localhost/api/health"),
  );
  if (response.status !== 200) throw new Error(`status ${response.status}`);
  const body = await response.json();
  if (body.ok !== true) throw new Error("health did not report ok");
  if (!body.version) throw new Error("health did not report a version");
});

Deno.test("an unknown route returns the shared error envelope", async () => {
  const app = createApp({ password: PASSWORD });
  const response = await app.fetch(
    new Request("http://localhost/nothing-here"),
  );
  if (response.status !== 404) throw new Error(`status ${response.status}`);
  const body = await response.json();
  if (typeof body.error?.code !== "string") {
    throw new Error("error envelope missing code");
  }
  if (typeof body.error?.message !== "string") {
    throw new Error("error envelope missing message");
  }
  if (typeof body.error?.requestId !== "string") {
    throw new Error("error envelope missing requestId");
  }
});

Deno.test("/api/* without a session returns 401", async () => {
  await withTempDb(async () => {
    const app = createApp({ password: PASSWORD });
    const response = await app.fetch(
      new Request("http://localhost/api/me", { headers: withCsrf() }),
    );
    if (response.status !== 401) throw new Error(`status ${response.status}`);
  });
});

Deno.test("a mutating request with no CSRF header is rejected before auth", async () => {
  await withTempDb(async () => {
    const app = createApp({ password: PASSWORD });
    const response = await app.fetch(postJson("/api/logout", {}));
    if (response.status !== 403) throw new Error(`status ${response.status}`);
  });
});

Deno.test("login, /api/me, logout, then the old token is rejected", async () => {
  await withTempDb(async () => {
    const app = createApp({ password: PASSWORD });
    const loginResponse = await app.fetch(
      postJson("/api/login", { password: PASSWORD }, withCsrf()),
    );
    if (loginResponse.status !== 200) {
      throw new Error(`login status ${loginResponse.status}`);
    }
    const { token, username, expiresAt } = await loginResponse.json();
    if (!token || username !== "admin" || !expiresAt) {
      throw new Error("login did not return a usable session");
    }

    const meResponse = await app.fetch(
      new Request("http://localhost/api/me", {
        headers: { ...withCsrf(), authorization: `Bearer ${token}` },
      }),
    );
    if (meResponse.status !== 200) {
      throw new Error(`/api/me status ${meResponse.status}`);
    }
    const me = await meResponse.json();
    if (me.username !== "admin") throw new Error("wrong username from /api/me");
    if (typeof me.setup?.ai !== "boolean") {
      throw new Error("/api/me did not report setup status");
    }
    if (!Array.isArray(me.missing)) {
      throw new Error("/api/me did not report what is missing");
    }

    const logoutResponse = await app.fetch(
      postJson("/api/logout", {}, {
        ...withCsrf(),
        authorization: `Bearer ${token}`,
      }),
    );
    if (logoutResponse.status !== 204) {
      throw new Error(`logout status ${logoutResponse.status}`);
    }

    const afterLogout = await app.fetch(
      new Request("http://localhost/api/me", {
        headers: { ...withCsrf(), authorization: `Bearer ${token}` },
      }),
    );
    if (afterLogout.status !== 401) {
      throw new Error("a logged-out token was still accepted");
    }
  });
});

Deno.test("a wrong password never creates a session", async () => {
  await withTempDb(async () => {
    const app = createApp({ password: PASSWORD });
    const response = await app.fetch(
      postJson("/api/login", { password: "nope" }, withCsrf()),
    );
    if (response.status !== 401) throw new Error(`status ${response.status}`);
  });
});

Deno.test("five wrong passwords lock out the sixth attempt, even the right one", async () => {
  await withTempDb(async () => {
    const app = createApp({ password: PASSWORD });
    const ip = "203.0.113.1";
    for (let i = 0; i < 5; i++) {
      const response = await app.fetch(
        postJson("/api/login", { password: "nope" }, withCsrf()),
        ip,
      );
      if (response.status !== 401) {
        throw new Error(`attempt ${i + 1} status ${response.status}`);
      }
    }
    const sixth = await app.fetch(
      postJson("/api/login", { password: PASSWORD }, withCsrf()),
      ip,
    );
    if (sixth.status !== 401) {
      throw new Error(
        `the sixth attempt with the correct password was not blocked, got ${sixth.status}`,
      );
    }
    const otherIp = await app.fetch(
      postJson("/api/login", { password: PASSWORD }, withCsrf()),
      "203.0.113.2",
    );
    if (otherIp.status !== 200) {
      throw new Error("a different IP was blocked by someone else's lockout");
    }
  });
});

Deno.test("inject500 returns 500 on mutating api except login", async () => {
  await withTempDb(async () => {
    const app = createApp({ password: PASSWORD, inject500: true });
    const login = await app.fetch(
      postJson("/api/login", { password: PASSWORD }, withCsrf()),
    );
    if (login.status !== 200) throw new Error(`login ${login.status}`);
    const { token } = await login.json();
    const me = await app.fetch(
      new Request("http://localhost/api/me", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    if (me.status !== 200) throw new Error(`GET still worked as ${me.status}`);
    const patch = await app.fetch(
      new Request("http://localhost/api/repos/acme/widgets", {
        method: "PATCH",
        headers: {
          ...withCsrf(),
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ autoReview: true }),
      }),
    );
    if (patch.status !== 500) throw new Error(`status ${patch.status}`);
    const body = await patch.json();
    if (body.error?.message !== "The request failed.") {
      throw new Error(JSON.stringify(body));
    }
  });
});
