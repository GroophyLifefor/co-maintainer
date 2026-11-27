import assert from "node:assert/strict";
import { test } from "node:test";
import { startFakeSaml, type FakeSaml, type SamlFaults } from "./fake_saml.ts";
import {
  browse,
  buildAuthnRequest,
  readMetadataKey,
  SamlError,
  verifyResponse,
  type SpConfig,
} from "./saml_sp.ts";

const ACS = "http://127.0.0.1:9/saml/acs";
const SP_ID = "https://co-maintainer.example/sp";

type Setup = { idp: FakeSaml; sp: SpConfig; used: Set<string> };

async function withIdp(
  run: (s: Setup) => Promise<void>,
  extra: { assertionSeconds?: number; sessionSeconds?: number } = {},
): Promise<void> {
  const idp = await startFakeSaml({
    audience: SP_ID,
    acsUrl: ACS,
    users: [
      {
        nameId: "ada@example.test",
        email: "ada@example.test",
        name: "Ada & Co <eng>",
        groups: ["eng", "admins"],
      },
      { nameId: "bob@example.test", email: "bob@example.test", name: "Bob" },
    ],
    ...extra,
  });
  try {
    const meta = await readMetadataKey(idp.metadataUrl);
    const sp: SpConfig = {
      entityId: SP_ID,
      acsUrl: ACS,
      idpEntityId: meta.entityId,
      idpSsoUrl: idp.ssoUrl,
      idpPublicKey: meta.publicKey,
    };
    await run({ idp, sp, used: new Set() });
  } finally {
    await idp.close();
  }
}

/** Sign in from the service provider and check what comes back. */
async function signIn(s: Setup, expect?: string) {
  const request = buildAuthnRequest(s.sp);
  const answer = await browse(request.url);
  assert.equal(answer.status, 200);
  return verifyResponse(s.sp, answer.samlResponse!, {
    expectedRequestId: expect ?? request.id,
    now: s.idp.now(),
    usedAssertionIds: s.used,
  });
}

async function code(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof SamlError) return error.code;
    throw error;
  }
  return "no error";
}

test("sign in: the signed assertion verifies and its fields read back, escaped text included", async () => {
  await withIdp(async (s) => {
    const login = await signIn(s);
    assert.equal(login.nameId, "ada@example.test");
    assert.equal(login.name, "Ada & Co <eng>");
    assert.deepEqual(login.groups, ["eng", "admins"]);
    assert.ok(login.sessionIndex.startsWith("_s"));
    s.idp.signInAs("bob@example.test");
    const bob = await signIn(s);
    assert.equal(bob.nameId, "bob@example.test");
    assert.deepEqual(bob.groups, []);
  });
});

test("the provider's key comes from its metadata", async () => {
  await withIdp(async (s) => {
    assert.equal(s.sp.idpPublicKey, s.idp.publicKey);
    assert.equal(s.sp.idpEntityId, s.idp.entityId);
  });
});

test("every bad response is refused with its own reason", async () => {
  const cases: [keyof SamlFaults, string][] = [
    ["tamperAfterSigning", "digest"],
    ["signedByStranger", "signature"],
    ["wrapping", "assertions"],
    ["unsigned", "unsigned"],
    ["wrongAudience", "audience"],
    ["wrongRecipient", "recipient"],
    ["wrongIssuer", "issuer"],
    ["expired", "expired"],
    ["omitInResponseTo", "unsolicited"],
  ];
  for (const [fault, expected] of cases) {
    await withIdp(async (s) => {
      s.idp.faults[fault] = true;
      assert.equal(await code(() => signIn(s)), expected, fault);
    });
  }
});

test("an assertion used twice is refused the second time", async () => {
  await withIdp(async (s) => {
    const request = buildAuthnRequest(s.sp);
    const answer = await browse(request.url);
    const context = {
      expectedRequestId: request.id,
      now: s.idp.now(),
      usedAssertionIds: s.used,
    };
    verifyResponse(s.sp, answer.samlResponse!, context);
    assert.equal(
      await code(async () =>
        verifyResponse(s.sp, answer.samlResponse!, context),
      ),
      "replay",
    );
  });
});

test("a response that answers another request, or none, is refused", async () => {
  await withIdp(async (s) => {
    assert.equal(await code(() => signIn(s, "_q-another")), "in_response_to");
    const { samlResponse } = s.idp.unsolicited();
    assert.equal(
      await code(async () =>
        verifyResponse(s.sp, samlResponse, {
          expectedRequestId: "_q1",
          now: s.idp.now(),
          usedAssertionIds: s.used,
        }),
      ),
      "unsolicited",
    );
  });
});

test("an assertion that is checked late has ended, by the provider's clock", async () => {
  await withIdp(async (s) => {
    const request = buildAuthnRequest(s.sp);
    const answer = await browse(request.url);
    s.idp.advance(10 * 60_000);
    assert.equal(
      await code(async () =>
        verifyResponse(s.sp, answer.samlResponse!, {
          expectedRequestId: request.id,
          now: s.idp.now(),
          usedAssertionIds: s.used,
        }),
      ),
      "expired",
    );
  });
});

test("the session end time is carried, and the provider ends a session on sign out", async () => {
  await withIdp(
    async (s) => {
      const login = await signIn(s);
      assert.equal(login.sessionNotOnOrAfter, s.idp.now() + 1800_000);
      const out = await fetch(
        `${s.idp.sloUrl}?SessionIndex=${login.sessionIndex}`,
      );
      assert.deepEqual(await out.json(), { loggedOut: true });
      const none = await fetch(s.idp.sloUrl);
      assert.deepEqual(await none.json(), { loggedOut: false });
    },
    { sessionSeconds: 1800 },
  );
});

test("the provider refuses a sign in request it cannot read", async () => {
  await withIdp(async (s) => {
    assert.equal((await browse(`${s.idp.ssoUrl}?SAMLRequest=%%%`)).status, 400);
    assert.equal((await browse(s.idp.ssoUrl)).status, 400);
  });
});
