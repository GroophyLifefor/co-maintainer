import assert from "node:assert/strict";
import { test } from "node:test";
import { startFakeOidc, type FakeOidc } from "./fake_oidc.ts";
import {
  browse,
  discover,
  finishLogin,
  logoutUrl,
  refresh,
  RpError,
  startLogin,
  userinfo,
  verifyIdToken,
  type Discovery,
  type RpConfig,
} from "./oidc_rp.ts";

const REDIRECT = "http://127.0.0.1:9/callback";
const AFTER = "http://127.0.0.1:9/signed-out";

type Setup = { idp: FakeOidc; config: RpConfig; discovery: Discovery };

async function withIdp(
  run: (s: Setup) => Promise<void>,
  extra: {
    idTokenSeconds?: number;
    refreshSeconds?: number;
    codeSeconds?: number;
  } = {},
): Promise<void> {
  const idp = await startFakeOidc({
    clientId: "co-maintainer",
    clientSecret: "test-secret",
    redirectUris: [REDIRECT],
    postLogoutRedirectUris: [AFTER],
    users: [
      { sub: "u-1", email: "ada@example.test", name: "Ada", groups: ["eng"] },
      { sub: "u-2", email: "bob@example.test", name: "Bob" },
    ],
    ...extra,
  });
  try {
    const discovery = await discover(idp.issuer);
    const config: RpConfig = {
      issuer: idp.issuer,
      clientId: "co-maintainer",
      clientSecret: "test-secret",
      redirectUri: REDIRECT,
    };
    await run({ idp, config, discovery });
  } finally {
    await idp.close();
  }
}

/** The whole sign-in: the browser goes to the provider and comes back. */
async function signIn({ idp, config, discovery }: Setup) {
  const { url, pending } = startLogin(config, discovery);
  const back = await browse(url);
  assert.equal(back.status, 302);
  const result = await finishLogin(
    config,
    discovery,
    pending,
    back.redirect!,
    idp.now(),
  );
  return { ...result, pending };
}

async function code(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof RpError) return error.code;
    throw error;
  }
  return "no error";
}

test("sign in: the code flow returns a verified ID token for the chosen user", async () => {
  await withIdp(async (s) => {
    const { claims } = await signIn(s);
    assert.equal(claims.sub, "u-1");
    assert.equal(claims.email, "ada@example.test");
    assert.deepEqual(claims.groups, ["eng"]);
    s.idp.signInAs("u-2");
    const second = await signIn(s);
    assert.equal(second.claims.sub, "u-2");
    assert.equal(second.claims.groups, undefined);
    const info = await userinfo(s.discovery, second.tokens.access_token);
    assert.equal(info.status, 200);
    assert.equal(info.body.email, "bob@example.test");
  });
});

test("an address that was not registered is never redirected to", async () => {
  await withIdp(async ({ config, discovery }) => {
    const { url } = startLogin(
      { ...config, redirectUri: "http://evil.test/cb" },
      discovery,
    );
    const answer = await browse(url);
    assert.equal(answer.status, 400);
    assert.equal(answer.redirect, undefined);
  });
});

test("a code is used once, and a second use ends the session it made", async () => {
  await withIdp(async (s) => {
    const { url, pending } = startLogin(s.config, s.discovery);
    const back = (await browse(url)).redirect!;
    const first = await finishLogin(
      s.config,
      s.discovery,
      pending,
      back,
      s.idp.now(),
    );
    assert.equal(
      await code(() =>
        finishLogin(s.config, s.discovery, pending, back, s.idp.now()),
      ),
      "invalid_grant",
    );
    // The replay revoked the session: what the first use got no longer works.
    assert.equal(
      (await userinfo(s.discovery, first.tokens.access_token)).status,
      401,
    );
  });
});

test("a code expires with the provider's clock, and a wrong PKCE verifier is refused", async () => {
  await withIdp(async (s) => {
    const a = startLogin(s.config, s.discovery);
    const backA = (await browse(a.url)).redirect!;
    s.idp.advance(61_000);
    assert.equal(
      await code(() =>
        finishLogin(s.config, s.discovery, a.pending, backA, s.idp.now()),
      ),
      "invalid_grant",
    );
    const b = startLogin(s.config, s.discovery);
    const backB = (await browse(b.url)).redirect!;
    assert.equal(
      await code(() =>
        finishLogin(
          s.config,
          s.discovery,
          { ...b.pending, verifier: "x".repeat(43) },
          backB,
          s.idp.now(),
        ),
      ),
      "invalid_grant",
    );
  });
});

test("a state that did not come back the same is refused before any token is asked for", async () => {
  await withIdp(async (s) => {
    const { url, pending } = startLogin(s.config, s.discovery);
    const back = (await browse(url)).redirect!;
    const before = s.idp.requests.length;
    assert.equal(
      await code(() =>
        finishLogin(
          s.config,
          s.discovery,
          { ...pending, state: "other" },
          back,
          s.idp.now(),
        ),
      ),
      "state",
    );
    assert.equal(s.idp.requests.length, before);
  });
});

test("an expired ID token is refused, and a refresh gives a new one", async () => {
  await withIdp(async (s) => {
    const { claims, tokens } = await signIn(s);
    assert.ok(claims.exp > 0);
    s.idp.advance(10 * 60_000);
    const checks = {
      issuer: s.config.issuer,
      audience: "co-maintainer",
      now: s.idp.now(),
    };
    assert.equal(
      await code(() => verifyIdToken(tokens.id_token!, s.discovery, checks)),
      "expired",
    );
    assert.equal(
      (await userinfo(s.discovery, tokens.access_token)).status,
      401,
    );
    const next = await refresh(s.config, s.discovery, tokens.refresh_token);
    const fresh = await verifyIdToken(next.id_token!, s.discovery, checks);
    assert.equal(fresh.sub, "u-1");
    // The old refresh token was used once: it does not work again.
    assert.equal(
      await code(() => refresh(s.config, s.discovery, tokens.refresh_token)),
      "invalid_grant",
    );
  });
});

test("the session ends when the refresh token's time is up", async () => {
  await withIdp(
    async (s) => {
      const { tokens } = await signIn(s);
      s.idp.advance(2 * 60 * 60_000);
      assert.equal(
        await code(() => refresh(s.config, s.discovery, tokens.refresh_token)),
        "invalid_grant",
      );
    },
    { refreshSeconds: 3600 },
  );
});

test("sign out: the provider ends the session, sends the browser back, and nothing refreshes", async () => {
  await withIdp(async (s) => {
    const { tokens } = await signIn(s);
    const out = await browse(
      logoutUrl(s.discovery, tokens.id_token!, AFTER, "bye"),
    );
    assert.equal(out.status, 302);
    assert.equal(out.redirect, `${AFTER}?state=bye`);
    assert.equal(
      await code(() => refresh(s.config, s.discovery, tokens.refresh_token)),
      "invalid_grant",
    );
    assert.equal(
      (await userinfo(s.discovery, tokens.access_token)).status,
      401,
    );
    // An address that was not registered for sign out gets no redirect.
    const other = await browse(
      logoutUrl(s.discovery, tokens.id_token!, "http://evil.test/", "x"),
    );
    assert.equal(other.redirect, undefined);
  });
});

test("every kind of bad ID token is refused with its own reason", async () => {
  const cases: [keyof Setup["idp"]["faults"], string][] = [
    ["badSignature", "signature"],
    ["wrongAudience", "audience"],
    ["wrongIssuer", "issuer"],
    ["wrongNonce", "nonce"],
    ["omitIdToken", "no_id_token"],
    ["omitTimes", "malformed"],
  ];
  for (const [fault, expected] of cases) {
    await withIdp(async (s) => {
      s.idp.faults[fault] = true;
      assert.equal(await code(() => signIn(s)), expected, fault);
    });
  }
});

test("a key that was replaced no longer verifies the tokens it signed", async () => {
  await withIdp(async (s) => {
    const { tokens } = await signIn(s);
    const checks = {
      issuer: s.config.issuer,
      audience: "co-maintainer",
      now: s.idp.now(),
    };
    s.idp.rotateKey();
    assert.equal(
      await code(() => verifyIdToken(tokens.id_token!, s.discovery, checks)),
      "unknown_key",
    );
    const again = await signIn(s);
    assert.equal(again.claims.sub, "u-1", "a new sign in uses the new key");
  });
});

test("a form body over the limit is refused, the provider keeps answering", async () => {
  await withIdp(async (s) => {
    const big = await fetch(s.discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `client_id=co-maintainer&junk=${"x".repeat(200_000)}`,
    }).then(
      (r) => r.status,
      () => "closed",
    );
    assert.ok(big === "closed" || big === 500 || big === 413, String(big));
    // Still alive afterwards.
    const { claims } = await signIn(s);
    assert.equal(claims.sub, "u-1");
  });
});

test("a client that is not the registered one is refused at the token endpoint", async () => {
  await withIdp(async (s) => {
    const { url, pending } = startLogin(s.config, s.discovery);
    const back = (await browse(url)).redirect!;
    const wrong = { ...s.config, clientSecret: "guess" };
    assert.equal(
      await code(() =>
        finishLogin(wrong, s.discovery, pending, back, s.idp.now()),
      ),
      "invalid_client",
    );
  });
});
