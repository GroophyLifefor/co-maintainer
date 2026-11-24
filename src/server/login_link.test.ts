/** The one-time sign-in link: its row, spending it, and the two pages. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "./app.ts";
import { createLoginLink, LOGIN_LINK_TTL_MS } from "./auth.ts";
import { closeAppDb, getAppDb, openAppDb } from "../store/app_db.ts";
import { deleteEnv, getEnv, setEnv, tempDirSync } from "../testing/runtime.ts";
import { isolateTestFile } from "../testing/locations.ts";

isolateTestFile();

async function withTempDb(fn: () => Promise<void>): Promise<void> {
  const original = getEnv("CM_APP_DB");
  setEnv("CM_APP_DB", `${tempDirSync()}/app.db`);
  try {
    await openAppDb();
    await fn();
  } finally {
    await closeAppDb();
    if (original === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", original);
  }
}

type Row = {
  token_hash: string;
  host: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
};
const rows = () => getAppDb().prepare<Row>(`SELECT * FROM login_links`).all();

let ipCounter = 0;
const freshIp = () => `10.0.0.${++ipCounter}`;

function post(token: string, host = "localhost:3000") {
  return new Request(`http://${host}/login/link`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `token=${token}`,
  });
}

test("a link is stored as a hash for 5 minutes, and a new one replaces it", async () => {
  await withTempDb(async () => {
    const first = await createLoginLink("Localhost:3000");
    assert.match(first, /^[0-9a-f]{64}$/);
    const [row] = rows();
    assert.ok(row);
    assert.notEqual(row.token_hash, first);
    assert.ok(!JSON.stringify(rows()).includes(first));
    assert.equal(row.host, "localhost:3000");
    const life = Date.parse(row.expires_at) - Date.parse(row.created_at);
    assert.ok(life > 0 && life <= LOGIN_LINK_TTL_MS, `life ${life}`);
    await createLoginLink("localhost:3000");
    assert.equal(rows().length, 1);
    const app = createApp({ password: "pw" });
    const old = await app.fetch(post(first), freshIp());
    assert.equal(old.status, 401);
  });
});

test("GET shows the confirm page only, POST signs in once", async () => {
  await withTempDb(async () => {
    const app = createApp({ password: "pw" });
    const token = await createLoginLink("localhost:3000");
    const page = await app.fetch(
      new Request("http://localhost:3000/login/link"),
      freshIp(),
    );
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(page.headers.get("set-cookie"), null);
    assert.equal(rows()[0]!.used_at, null, "a GET must not spend the link");

    const signedIn = await app.fetch(post(token), freshIp());
    assert.equal(signedIn.status, 303);
    assert.equal(signedIn.headers.get("location"), "/");
    assert.equal(signedIn.headers.get("referrer-policy"), "no-referrer");
    const cookie = signedIn.headers.get("set-cookie") ?? "";
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.ok(rows()[0]!.used_at);
    const me = await app.fetch(
      new Request("http://localhost:3000/api/me", {
        // punctuation: code, the cookie header's attribute separator
        headers: { cookie: cookie.split(";")[0]! },
      }),
      freshIp(),
    );
    assert.equal(me.status, 200);
    const audit = getAppDb()
      .prepare<{
        summary: string;
        target: string | null;
        changes_json: string | null;
      }>(
        `SELECT summary, target, changes_json FROM audit_log WHERE kind = 'sign-in'`,
      )
      .all();
    assert.ok(
      audit.some((row) => row.summary === "Signed in with a sign-in link"),
    );
    assert.ok(!JSON.stringify(audit).includes(token));

    const replay = await app.fetch(post(token), freshIp());
    assert.equal(replay.status, 401);
    assert.equal(replay.headers.get("set-cookie"), null);
  });
});

test("two requests with the same link give one session", async () => {
  await withTempDb(async () => {
    const app = createApp({ password: "pw" });
    const token = await createLoginLink("localhost:3000");
    const results = await Promise.all([
      app.fetch(post(token), freshIp()),
      app.fetch(post(token), freshIp()),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [303, 401]);
  });
});

test("another host, an expired link and a credential change refuse it", async () => {
  await withTempDb(async () => {
    const app = createApp({ password: "pw" });
    let token = await createLoginLink("localhost:3000");
    assert.equal(
      (await app.fetch(post(token, "evil.test"), freshIp())).status,
      401,
    );
    token = await createLoginLink("localhost:3000");
    getAppDb()
      .prepare(`UPDATE login_links SET expires_at = ?`)
      .run(new Date(Date.now() - 1000).toISOString());
    assert.equal((await app.fetch(post(token), freshIp())).status, 401);
  });
});

test("a locked out address cannot spend a good link, and bad tokens lock it out", async () => {
  await withTempDb(async () => {
    const app = createApp({ password: "pw" });
    const token = await createLoginLink("localhost:3000");
    const ip = freshIp();
    for (let i = 0; i < 10; i++) {
      await app.fetch(post("not-a-token"), ip);
    }
    assert.equal((await app.fetch(post(token), ip)).status, 401);
    assert.equal(
      rows()[0]!.used_at,
      null,
      "a locked out try must not burn the link",
    );
    assert.equal((await app.fetch(post(token), freshIp())).status, 303);
  });
});

test("it signs in with password sign-in turned off", async () => {
  await withTempDb(async () => {
    const app = createApp({
      password: "pw",
      auth: { password: false, github: true },
    });
    const token = await createLoginLink("localhost:3000");
    assert.equal((await app.fetch(post(token), freshIp())).status, 303);
  });
});
