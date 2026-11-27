/** A small OpenID Connect relying party for the fake provider's tests: what
 * the enterprise sign-in must do, written plainly, so the provider's answers
 * are checked by something that checks them the way a real client does.
 *
 * It is test support, not the product's sign-in. When that exists it is run
 * against the same fake provider. */
import {
  createHash,
  createPublicKey,
  createVerify,
  randomBytes,
} from "node:crypto";

export type RpConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  end_session_endpoint: string;
};

export type Pending = { state: string; nonce: string; verifier: string };

export type Claims = Record<string, unknown> & {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
};

export type TokenAnswer = {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in: number;
};

export class RpError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function discover(issuer: string): Promise<Discovery> {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`);
  return (await response.json()) as Discovery;
}

/** The address to send the browser to, and what to keep until it returns. */
export function startLogin(
  config: RpConfig,
  discovery: Discovery,
): { url: string; pending: Pending } {
  const pending: Pending = {
    state: randomBytes(8).toString("hex"),
    nonce: randomBytes(8).toString("hex"),
    verifier: randomBytes(32).toString("base64url"),
  };
  const url = new URL(discovery.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: "openid email profile offline_access",
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: createHash("sha256")
      .update(pending.verifier)
      .digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), pending };
}

/** The browser: opens the authorize address and returns where the provider
 * sent it back, or the provider's own answer when it did not redirect. */
export async function browse(
  url: string,
): Promise<{ redirect?: string; status: number }> {
  const response = await fetch(url, { redirect: "manual" });
  const redirect = response.headers.get("location") ?? undefined;
  return { status: response.status, ...(redirect ? { redirect } : {}) };
}

async function tokenCall(
  discovery: Discovery,
  config: RpConfig,
  form: Record<string, string>,
): Promise<TokenAnswer> {
  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      ...form,
    }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new RpError(
      String(body.error ?? "token_error"),
      "token request refused",
    );
  }
  return body as unknown as TokenAnswer;
}

export type Checks = {
  issuer: string;
  audience: string;
  nonce?: string;
  /** The relying party's clock, in milliseconds. */
  now: number;
  /** Seconds of difference between the clocks that is accepted. */
  skew?: number;
};

/** Checks a signed ID token the way a client must: the key by `kid` in the
 * provider's own key set, RS256 only, then issuer, audience, nonce and times.
 * Throws an `RpError` whose code says which check failed. */
export async function verifyIdToken(
  token: string,
  discovery: Discovery,
  checks: Checks,
): Promise<Claims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new RpError("malformed", "not a JWT");
  const [head64, body64, signature64] = parts as [string, string, string];
  const head = JSON.parse(
    Buffer.from(head64, "base64url").toString("utf8"),
  ) as {
    alg?: string;
    kid?: string;
  };
  if (head.alg !== "RS256") throw new RpError("alg", "only RS256 is accepted");
  const keys = (await (await fetch(discovery.jwks_uri)).json()) as {
    keys: ({ kid?: string } & Record<string, unknown>)[];
  };
  const jwk = keys.keys.find((k) => k.kid === head.kid);
  if (!jwk) throw new RpError("unknown_key", "no such key in the key set");
  const valid = createVerify("RSA-SHA256")
    .update(`${head64}.${body64}`)
    .verify(
      createPublicKey({ key: jwk as never, format: "jwk" }),
      Buffer.from(signature64, "base64url"),
    );
  if (!valid) throw new RpError("signature", "the signature does not match");
  const claims = JSON.parse(
    Buffer.from(body64, "base64url").toString("utf8"),
  ) as Claims;
  if (claims.iss !== checks.issuer) throw new RpError("issuer", "wrong issuer");
  if (claims.aud !== checks.audience)
    throw new RpError("audience", "wrong audience");
  if (checks.nonce !== undefined && claims.nonce !== checks.nonce) {
    throw new RpError("nonce", "wrong nonce");
  }
  const skewMs = (checks.skew ?? 30) * 1000;
  if (checks.now > claims.exp * 1000 + skewMs) {
    throw new RpError("expired", "the ID token has expired");
  }
  if (claims.iat * 1000 > checks.now + skewMs) {
    throw new RpError("not_yet", "the ID token is from the future");
  }
  return claims;
}

/** Finishes a sign-in from the address the provider sent the browser back to. */
export async function finishLogin(
  config: RpConfig,
  discovery: Discovery,
  pending: Pending,
  callback: string,
  now: number,
): Promise<{ claims: Claims; tokens: TokenAnswer }> {
  const url = new URL(callback);
  const error = url.searchParams.get("error");
  if (error) throw new RpError(error, "the provider refused");
  if (url.searchParams.get("state") !== pending.state) {
    throw new RpError("state", "the state does not match");
  }
  const tokens = await tokenCall(discovery, config, {
    grant_type: "authorization_code",
    code: url.searchParams.get("code") ?? "",
    redirect_uri: config.redirectUri,
    code_verifier: pending.verifier,
  });
  if (!tokens.id_token) throw new RpError("no_id_token", "no ID token");
  const claims = await verifyIdToken(tokens.id_token, discovery, {
    issuer: config.issuer,
    audience: config.clientId,
    nonce: pending.nonce,
    now,
  });
  return { claims, tokens };
}

export function refresh(
  config: RpConfig,
  discovery: Discovery,
  refreshToken: string,
): Promise<TokenAnswer> {
  return tokenCall(discovery, config, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

export async function userinfo(
  discovery: Discovery,
  accessToken: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(discovery.userinfo_endpoint, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

export function logoutUrl(
  discovery: Discovery,
  idToken: string,
  postLogout: string,
  state: string,
): string {
  const url = new URL(discovery.end_session_endpoint);
  url.search = new URLSearchParams({
    id_token_hint: idToken,
    post_logout_redirect_uri: postLogout,
    state,
  }).toString();
  return url.toString();
}
