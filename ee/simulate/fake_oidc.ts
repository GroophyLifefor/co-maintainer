/** A fake OpenID Connect identity provider for tests of the enterprise sign-in.
 *
 * It runs in the test's own process on a loopback port and speaks the parts of
 * the authorization code flow a relying party uses: discovery, the key set,
 * authorize, token (code and refresh), userinfo and end session. It signs
 * real RS256 tokens with a throwaway key, so the relying party's checks run
 * for real. Time is its own clock, so an expired token or session is made by
 * moving the clock and never by waiting.
 *
 * Faults are switches on the object: a token that is signed wrongly, for
 * another audience, another issuer or another nonce, a key that was replaced.
 * No real provider, network or secret is involved. */
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export type FakeUser = {
  sub: string;
  email: string;
  name: string;
  groups?: string[];
};

export type FakeOidcOptions = {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  postLogoutRedirectUris?: string[];
  users: FakeUser[];
  /** Seconds. Defaults: id and access token 300, refresh token 3600, code 60. */
  idTokenSeconds?: number;
  refreshSeconds?: number;
  codeSeconds?: number;
  /** The clock's start, in milliseconds. */
  startAt?: number;
};

type Session = {
  id: string;
  user: FakeUser;
  clientId: string;
  nonce: string | undefined;
  authTime: number;
  revoked: boolean;
};

type Code = {
  session: Session;
  redirectUri: string;
  challenge: string;
  expiresAt: number;
  used: boolean;
};

type Refresh = { session: Session; expiresAt: number; used: boolean };

export type Faults = {
  /** Sign the next ID tokens with a key that is not in the key set. */
  badSignature: boolean;
  /** Put another audience in the ID token. */
  wrongAudience: boolean;
  wrongIssuer: boolean;
  /** Answer with a nonce the request did not carry. */
  wrongNonce: boolean;
  /** Leave the ID token out of the token answer. */
  omitIdToken: boolean;
};

export type FakeOidc = {
  issuer: string;
  /** The identity provider's clock, in milliseconds. */
  now(): number;
  advance(ms: number): void;
  faults: Faults;
  /** Which user the next authorize request signs in. Defaults to the first. */
  signInAs(sub: string): void;
  /** Replaces the signing key: tokens made before it no longer verify. */
  rotateKey(): void;
  /** Every request the provider answered, as `METHOD path`. */
  requests: string[];
  close(): Promise<void>;
};

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function newKey(): { kid: string; privateKey: KeyObject; jwk: JsonWebKey } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const kid = `fake-${randomBytes(4).toString("hex")}`;
  return {
    kid,
    privateKey,
    jwk: {
      ...publicKey.export({ format: "jwk" }),
      kid,
      alg: "RS256",
      use: "sig",
    },
  };
}

function sign(
  privateKey: KeyObject,
  kid: string,
  claims: Record<string, unknown>,
): string {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const body = b64url(JSON.stringify(claims));
  const signature = createSign("RSA-SHA256")
    .update(`${head}.${body}`)
    .sign(privateKey);
  return `${head}.${body}.${b64url(signature)}`;
}

export async function startFakeOidc(
  options: FakeOidcOptions,
): Promise<FakeOidc> {
  const idSeconds = options.idTokenSeconds ?? 300;
  const refreshSeconds = options.refreshSeconds ?? 3600;
  const codeSeconds = options.codeSeconds ?? 60;
  let clock = options.startAt ?? Date.UTC(2027, 0, 1);
  let key = newKey();
  const strangerKey = newKey();
  let signedInAs = options.users[0]!.sub;
  const codes = new Map<string, Code>();
  const refreshTokens = new Map<string, Refresh>();
  const accessTokens = new Map<
    string,
    { session: Session; expiresAt: number }
  >();
  const sessions = new Map<string, Session>();
  const requests: string[] = [];
  const faults: Faults = {
    badSignature: false,
    wrongAudience: false,
    wrongIssuer: false,
    wrongNonce: false,
    omitIdToken: false,
  };

  let issuer = "";

  const idToken = (session: Session): string => {
    const iat = Math.floor(clock / 1000);
    const signer = faults.badSignature ? strangerKey : key;
    return sign(signer.privateKey, signer.kid, {
      iss: faults.wrongIssuer ? `${issuer}/other` : issuer,
      sub: session.user.sub,
      aud: faults.wrongAudience ? "another-client" : session.clientId,
      iat,
      exp: iat + idSeconds,
      auth_time: Math.floor(session.authTime / 1000),
      nonce: faults.wrongNonce ? "nonce-it-never-sent" : session.nonce,
      email: session.user.email,
      name: session.user.name,
      ...(session.user.groups ? { groups: session.user.groups } : {}),
      sid: session.id,
    });
  };

  const tokenAnswer = (session: Session): Record<string, unknown> => {
    const access = `at-${randomBytes(12).toString("hex")}`;
    accessTokens.set(access, {
      session,
      expiresAt: clock + idSeconds * 1000,
    });
    const refresh = `rt-${randomBytes(12).toString("hex")}`;
    refreshTokens.set(refresh, {
      session,
      expiresAt: clock + refreshSeconds * 1000,
      used: false,
    });
    return {
      token_type: "Bearer",
      access_token: access,
      expires_in: idSeconds,
      refresh_token: refresh,
      ...(faults.omitIdToken ? {} : { id_token: idToken(session) }),
    };
  };

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", issuer || "http://127.0.0.1");
      requests.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/.well-known/openid-configuration") {
        return json(response, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
          jwks_uri: `${issuer}/jwks`,
          end_session_endpoint: `${issuer}/logout`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["openid", "email", "profile", "offline_access"],
        });
      }
      if (url.pathname === "/jwks") {
        return json(response, 200, { keys: [key.jwk] });
      }
      if (url.pathname === "/authorize") {
        const q = url.searchParams;
        const redirectUri = q.get("redirect_uri") ?? "";
        // An address that was not registered is never redirected to.
        if (
          q.get("client_id") !== options.clientId ||
          !options.redirectUris.includes(redirectUri)
        ) {
          return json(response, 400, { error: "invalid_request" });
        }
        const back = new URL(redirectUri);
        const state = q.get("state");
        if (state !== null) back.searchParams.set("state", state);
        if (
          q.get("response_type") !== "code" ||
          q.get("code_challenge_method") !== "S256" ||
          !q.get("code_challenge")
        ) {
          back.searchParams.set("error", "invalid_request");
          response.writeHead(302, { location: back.toString() });
          return response.end();
        }
        const user = options.users.find((u) => u.sub === signedInAs)!;
        const session: Session = {
          id: `sid-${randomBytes(6).toString("hex")}`,
          user,
          clientId: options.clientId,
          nonce: q.get("nonce") ?? undefined,
          authTime: clock,
          revoked: false,
        };
        sessions.set(session.id, session);
        const code = `code-${randomBytes(12).toString("hex")}`;
        codes.set(code, {
          session,
          redirectUri,
          challenge: q.get("code_challenge")!,
          expiresAt: clock + codeSeconds * 1000,
          used: false,
        });
        back.searchParams.set("code", code);
        response.writeHead(302, { location: back.toString() });
        return response.end();
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const form = await readForm(request);
        const basic = request.headers.authorization?.startsWith("Basic ")
          ? Buffer.from(request.headers.authorization.slice(6), "base64")
              .toString("utf8")
              .split(":")
          : [];
        const id = form.get("client_id") ?? basic[0];
        const secret = form.get("client_secret") ?? basic[1];
        if (id !== options.clientId || secret !== options.clientSecret) {
          return json(response, 401, { error: "invalid_client" });
        }
        const grant = form.get("grant_type");
        if (grant === "authorization_code") {
          const code = codes.get(form.get("code") ?? "");
          const verifier = form.get("code_verifier") ?? "";
          const challenge = createHash("sha256")
            .update(verifier)
            .digest("base64url");
          if (
            !code ||
            code.used ||
            clock > code.expiresAt ||
            code.session.revoked ||
            code.redirectUri !== form.get("redirect_uri") ||
            code.challenge !== challenge
          ) {
            // A code that is used twice also ends the session it made.
            if (code?.used) code.session.revoked = true;
            return json(response, 400, { error: "invalid_grant" });
          }
          code.used = true;
          return json(response, 200, tokenAnswer(code.session));
        }
        if (grant === "refresh_token") {
          const old = refreshTokens.get(form.get("refresh_token") ?? "");
          if (
            !old ||
            old.used ||
            clock > old.expiresAt ||
            old.session.revoked
          ) {
            if (old?.used) old.session.revoked = true;
            return json(response, 400, { error: "invalid_grant" });
          }
          // A refresh token is used once: the answer carries the next one.
          old.used = true;
          return json(response, 200, tokenAnswer(old.session));
        }
        return json(response, 400, { error: "unsupported_grant_type" });
      }
      if (url.pathname === "/userinfo") {
        const bearer = (request.headers.authorization ?? "").replace(
          /^Bearer /,
          "",
        );
        const token = accessTokens.get(bearer);
        if (!token || clock > token.expiresAt || token.session.revoked) {
          return json(response, 401, { error: "invalid_token" });
        }
        const user = token.session.user;
        return json(response, 200, {
          sub: user.sub,
          email: user.email,
          name: user.name,
          ...(user.groups ? { groups: user.groups } : {}),
        });
      }
      if (url.pathname === "/logout") {
        const hint = url.searchParams.get("id_token_hint") ?? "";
        const sid = (() => {
          try {
            const body = JSON.parse(
              Buffer.from(hint.split(".")[1] ?? "", "base64url").toString(
                "utf8",
              ),
            ) as { sid?: string };
            return body.sid;
          } catch {
            return undefined;
          }
        })();
        const session = sid ? sessions.get(sid) : undefined;
        if (session) session.revoked = true;
        const back = url.searchParams.get("post_logout_redirect_uri");
        if (back && (options.postLogoutRedirectUris ?? []).includes(back)) {
          const target = new URL(back);
          const state = url.searchParams.get("state");
          if (state !== null) target.searchParams.set("state", state);
          response.writeHead(302, { location: target.toString() });
          return response.end();
        }
        return json(response, 200, { loggedOut: Boolean(session) });
      }
      json(response, 404, { error: "not_found" });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    faults,
    signInAs: (sub) => {
      if (!options.users.some((u) => u.sub === sub)) {
        throw new Error(`no such fake user: ${sub}`);
      }
      signedInAs = sub;
    },
    rotateKey: () => {
      key = newKey();
    },
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
