/** Sign in with ChatGPT (experimental).
 *
 * Runs the Responses API on a user's ChatGPT plan through OpenAI's
 * open-source Sign in with ChatGPT flow, instead of an API key. The OAuth
 * dance registers a client on first use, keeps the tokens in
 * `~/.config/co-maintainer/oauth/sign-in-with-chatgpt.json` (0600), and
 * refreshes them. The Responses translation itself lives in `openai.ts` and
 * is shared; this file only adds the auth and the plan-usage request shape.
 *
 * Route quirks this file exists to respect (confirmed against the live
 * route): `store:false` and `stream:true` are required, `max_output_tokens`
 * is rejected, system messages are rejected in favor of `instructions`, and
 * there is no `previous_response_id`, so the full history is sent each time.
 */
import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  CliError,
  EXIT_RUNTIME,
  EXIT_USAGE,
  networkFailure,
} from "../../cli/error.ts";
import { getConfigDir } from "../../config.ts";
import {
  chmod,
  getEnv,
  isNotFound,
  mkdir,
  readTextFileSync,
  remove,
  writeTextFile,
} from "../../util/runtime.ts";
import {
  parseResponsesBody,
  readResponsesStream,
  responsesBody,
} from "../openai.ts";
import type { AiProvider, AiRequest, AiResponse, Json } from "../../types.ts";
import { SIWC_ALIAS, SIWC_LABEL, SIWC_PROVIDER } from "./ids.ts";

export { SIWC_ALIAS, SIWC_LABEL, SIWC_PROVIDER };

const CALLBACK_PATH = "/auth/callback";
const APP_NAME = "co-maintainer";
const DEFAULT_CLIENT_ID = "dynamic_agent_client";
const SCOPE =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const HELP_URL = "https://developers.openai.com/siwc/token-sharing-open-source";

/** How long the browser sign-in waits for the callback. `CM_SIWC_LOGIN_TIMEOUT_MS`
 * overrides it so a test can prove the loopback server closes on a timeout
 * without waiting five minutes. */
function loginTimeoutMs(): number {
  const raw = Number(getEnv("CM_SIWC_LOGIN_TIMEOUT_MS"));
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000;
}

/** `CM_SIWC_AUTH_URL` and `CM_SIWC_API_URL` point the flow at local fakes in
 * tests; unset means the real endpoints. `CM_SIWC_DIR` moves the credentials
 * file so tests never touch the real one. */
function authOrigin(): string {
  return (getEnv("CM_SIWC_AUTH_URL") ?? "https://auth.openai.com").replace(
    /\/$/,
    "",
  );
}
function accountBase(): string {
  return `${authOrigin()}/api/accounts`;
}
function apiBase(): string {
  return (getEnv("CM_SIWC_API_URL") ?? "https://api.openai.com/v1").replace(
    /\/$/,
    "",
  );
}

export function credentialsDir(): string {
  return getEnv("CM_SIWC_DIR") ?? `${getConfigDir()}/co-maintainer/oauth`;
}

export function credentialsPath(): string {
  return `${credentialsDir()}/${SIWC_PROVIDER}.json`;
}

export type Credentials = {
  email?: string;
  issuer: string;
  subject: string;
  client_id: string;
  ext_agent_host_id: string;
  id_token: string;
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number;
  scopes: string[];
  saved_at: string;
};

/** OpenRouter-style ids carry a provider prefix (`openai/gpt-6-luna`) the
 * plan route does not know. Stripping it lets the same value work on both. */
export function normalizeModel(model: string): string {
  return model.replace(/^openai\//, "");
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function query(params: Record<string, string>): string {
  return Object.entries(params)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join("&");
}

function decodeJwt(token: string): {
  header: { alg?: string; kid?: string };
  payload: Json;
  signingInput: string;
  signature: Buffer;
} {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("id_token is not a JWT");
  const [header, payload, signature] = parts;
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
    payload: JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Json,
    signingInput: `${header}.${payload}`,
    signature: Buffer.from(signature, "base64url"),
  };
}

async function fetchJson(url: string): Promise<Json> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return (await response.json()) as Json;
}

async function verifySignature(
  header: { alg?: string; kid?: string },
  signingInput: string,
  signature: Buffer,
): Promise<void> {
  if (header.alg !== "RS256") {
    throw new Error(`unsupported id_token algorithm ${header.alg}`);
  }
  const discovery = await fetchJson(
    `${authOrigin()}/.well-known/openid-configuration`,
  );
  const jwksUri = discovery.jwks_uri;
  if (typeof jwksUri !== "string") throw new Error("no jwks_uri in discovery");
  const jwks = await fetchJson(jwksUri);
  const keys = Array.isArray(jwks.keys) ? (jwks.keys as Json[]) : [];
  const jwk = keys.find((key) => key.kid === header.kid) ?? keys[0];
  if (!jwk) throw new Error("no JWKS key for the id_token");
  const publicKey = createPublicKey({ key: jwk as never, format: "jwk" });
  const ok = verify(
    "RSA-SHA256",
    Buffer.from(signingInput),
    publicKey,
    signature,
  );
  if (!ok) throw new Error("id_token signature did not verify");
}

function audiences(payload: Json): string[] {
  const aud = payload.aud;
  if (typeof aud === "string") return [aud];
  if (Array.isArray(aud)) return aud.map(String);
  return [];
}

async function validateIdToken(
  idToken: string,
  clientId: string,
  nonce?: string,
): Promise<{ subject: string; email?: string }> {
  const { header, payload, signingInput, signature } = decodeJwt(idToken);
  if (String(payload.iss ?? "") !== authOrigin()) {
    throw new Error(`id_token issuer ${payload.iss} is not ${authOrigin()}`);
  }
  if (!audiences(payload).includes(clientId)) {
    throw new Error("id_token audience does not match the client id");
  }
  const exp = Number(payload.exp ?? 0);
  if (!exp || exp * 1000 < Date.now()) throw new Error("id_token expired");
  if (nonce && payload.nonce !== nonce)
    throw new Error("id_token nonce mismatch");
  await verifySignature(header, signingInput, signature);
  return {
    subject: String(payload.sub ?? ""),
    email: typeof payload.email === "string" ? payload.email : undefined,
  };
}

export function loadCredentials(): Credentials | undefined {
  try {
    return JSON.parse(readTextFileSync(credentialsPath())) as Credentials;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    return undefined;
  }
}

async function saveCredentials(creds: Credentials): Promise<void> {
  const path = credentialsPath();
  await mkdir(path.replace(/\/[^/]+$/, ""), { recursive: true });
  await writeTextFile(path, `${JSON.stringify(creds, null, 2)}\n`);
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows has no POSIX chmod; NotSupported there is expected.
  }
}

/** Keeps the issued client id even when the code exchange fails, so a later
 * run reauthorizes with it instead of registering again. */
async function rememberClientId(
  clientId: string,
  hostId: string,
): Promise<void> {
  const current = loadCredentials();
  await saveCredentials({
    ...(current ?? ({} as Credentials)),
    issuer: authOrigin(),
    client_id: clientId,
    ext_agent_host_id: hostId,
    saved_at: new Date().toISOString(),
  } as Credentials);
}

export async function logout(): Promise<boolean> {
  const path = credentialsPath();
  try {
    await remove(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

type BrowserOpener = (url: string) => void;

let browserOpener: BrowserOpener | undefined;

/** Tests replace the browser with a helper that completes the callback; the
 * real opener shells out to the platform's open command. */
export function setBrowserOpener(opener: BrowserOpener | undefined): void {
  browserOpener = opener;
}

function openBrowser(url: string): void {
  if (browserOpener) {
    browserOpener(url);
    return;
  }
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // No browser here; the printed URL is the fallback.
  }
}

type CallbackResult = {
  code?: string;
  state?: string;
  client_id?: string;
  error?: string;
  error_description?: string;
};

async function tokenRequest(body: Record<string, string>): Promise<Json> {
  let response: Response;
  try {
    response = await fetch(`${accountBase()}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: query(body),
    });
  } catch (error) {
    throw networkFailure(`${accountBase()}/oauth/token`, error);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`token endpoint ${response.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as Json;
}

function invalidGrant(error: unknown): boolean {
  return error instanceof Error && error.message.includes("invalid_grant");
}

type AuthorizeResult = {
  code: string;
  issuedClientId?: string;
  redirectUri: string;
  verifier: string;
  nonce: string;
};

async function authorize(opts: {
  clientId: string;
  hostId: string;
  agentNameHint?: string;
  idTokenHint?: string;
  loginHint?: string;
}): Promise<AuthorizeResult> {
  let resolveCallback!: (result: CallbackResult) => void;
  const pending = new Promise<CallbackResult>((resolve) => {
    resolveCallback = resolve;
  });
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<h2>Signed in. You can close this tab.</h2>");
    resolveCallback({
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
      client_id: url.searchParams.get("client_id") ?? undefined,
      error: url.searchParams.get("error") ?? undefined,
      error_description: url.searchParams.get("error_description") ?? undefined,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));

  const params: Record<string, string> = {
    client_id: opts.clientId,
    ext_agent_host_id: opts.hostId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPE,
    resource: `${apiBase()}`,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: challenge,
  };
  if (opts.agentNameHint) params.agent_name_hint = opts.agentNameHint;
  if (opts.idTokenHint) params.id_token_hint = opts.idTokenHint;
  if (opts.loginHint) params.login_hint = opts.loginHint;

  const url = `${accountBase()}/authorize?${query(params)}`;
  console.log("Open this URL to sign in with ChatGPT:");
  console.log(url);
  openBrowser(url);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("timed out waiting for the browser sign-in")),
      loginTimeoutMs(),
    );
    timer.unref?.();
  });
  let result: CallbackResult | undefined;
  try {
    result = await Promise.race([pending, timeout]);
  } finally {
    // The timeout path must not leave the loopback server listening, or it
    // keeps the CLI process alive after the sign-in failed.
    if (timer) clearTimeout(timer);
    server.close();
  }
  if (!result) throw new Error("sign-in ended without a result");

  if (result.error) {
    throw new CliError(
      "siwc_denied",
      `ChatGPT denied access (${result.error}).`,
      `This may be because the account has no paid ChatGPT subscription (Go, Plus or Pro is required). See ${HELP_URL}`,
      EXIT_USAGE,
    );
  }
  if (result.state !== state) throw new Error("state mismatch on callback");
  if (!result.code) throw new Error("no code on callback");
  return {
    code: result.code,
    issuedClientId: result.client_id,
    redirectUri,
    verifier,
    nonce,
  };
}

async function exchange(
  clientId: string,
  result: AuthorizeResult,
): Promise<Json> {
  return tokenRequest({
    grant_type: "authorization_code",
    client_id: clientId,
    code: result.code,
    code_verifier: result.verifier,
    redirect_uri: result.redirectUri,
    resource: apiBase(),
  });
}

function toCredentials(
  token: Json,
  clientId: string,
  hostId: string,
  identity: { subject: string; email?: string },
): Credentials {
  const expiresIn = Number(token.expires_in ?? 3600);
  return {
    subject: identity.subject,
    ...(identity.email ? { email: identity.email } : {}),
    issuer: authOrigin(),
    client_id: clientId,
    ext_agent_host_id: hostId,
    id_token: String(token.id_token ?? ""),
    access_token: String(token.access_token ?? ""),
    refresh_token: String(token.refresh_token ?? ""),
    token_type: String(token.token_type ?? "Bearer"),
    expires_in: expiresIn,
    expires_at: Date.now() + expiresIn * 1000,
    scopes:
      typeof token.scope === "string" && token.scope
        ? token.scope.split(" ")
        : [],
    saved_at: new Date().toISOString(),
  };
}

let cached: Credentials | undefined;

/** The freshest credentials this process has seen. `complete()` refreshes on a
 * 401, and this is what makes the new token visible to the next caller instead
 * of the stale record `ensureCredentials` resolved earlier. */
function remember(creds: Credentials): Credentials {
  cached = creds;
  return creds;
}

/** The browser flow. Always runs, so a user can switch accounts; `logout`
 * first if the old one should not be reused. */
export async function login(): Promise<Credentials> {
  const existing = loadCredentials();
  const hostId = existing?.ext_agent_host_id ?? `urn:uuid:${randomUUID()}`;

  let attempt = await authorize({
    clientId: existing?.client_id ?? DEFAULT_CLIENT_ID,
    hostId,
    agentNameHint: existing ? undefined : APP_NAME,
    idTokenHint: existing?.id_token,
    loginHint: existing?.email,
  });
  let clientId = attempt.issuedClientId ?? existing?.client_id;
  if (!clientId) throw new Error("registration did not return a client id");
  await rememberClientId(clientId, hostId);

  let token: Json;
  try {
    token = await exchange(clientId, attempt);
  } catch (error) {
    if (!invalidGrant(error) || !attempt.issuedClientId) throw error;
    console.log("Retrying the sign-in with the issued client id.");
    clientId = attempt.issuedClientId;
    attempt = await authorize({ clientId, hostId });
    token = await exchange(clientId, attempt);
  }

  const identity = await validateIdToken(
    String(token.id_token ?? ""),
    clientId,
    attempt.nonce,
  );
  const creds = toCredentials(token, clientId, hostId, identity);
  await saveCredentials(creds);
  return remember(creds);
}

export async function refresh(creds: Credentials): Promise<Credentials> {
  const token = await tokenRequest({
    grant_type: "refresh_token",
    client_id: creds.client_id,
    refresh_token: creds.refresh_token,
    resource: apiBase(),
  });
  const identity = await validateIdToken(
    String(token.id_token ?? creds.id_token),
    creds.client_id,
  );
  const next = toCredentials(
    { ...token, refresh_token: token.refresh_token ?? creds.refresh_token },
    creds.client_id,
    creds.ext_agent_host_id,
    identity,
  );
  await saveCredentials(next);
  return remember(next);
}

function requireInteractive(): void {
  if (process.stdin.isTTY !== true) {
    throw new CliError(
      "siwc_no_browser",
      "Sign in with ChatGPT needs a browser, which is not available here.",
      `Run co-maintainer oauth login --provider=${SIWC_PROVIDER} on a machine with a browser.`,
      EXIT_USAGE,
    );
  }
}

let inflight: Promise<Credentials> | undefined;

/** Credentials for a run: reuse the freshest token this process has seen,
 * refresh an expired one, or start the browser flow. `inflight` dedups so
 * `init`'s low and high providers never open two browsers; `cached` keeps a
 * 401 refresh done inside `complete()` visible to later callers. */
export function ensureCredentials(): Promise<Credentials> {
  if (cached && cached.expires_at - 60_000 > Date.now()) {
    return Promise.resolve(cached);
  }
  if (inflight) return inflight;
  inflight = (async () => {
    const existing = cached ?? loadCredentials();
    if (existing?.refresh_token) {
      if (existing.expires_at - 60_000 > Date.now()) return existing;
      return refresh(existing);
    }
    requireInteractive();
    return login();
  })();
  inflight.catch(() => {
    inflight = undefined;
  });
  return inflight;
}

export type ModelInfo = { slug: string; displayName: string };

/** For `oauth refresh|ping|list-models`, which operate on an existing login
 * and must not start a browser flow. A live token is reused, an expired one
 * refreshed; no login at all is a clear error. */
export async function requireCredentials(): Promise<Credentials> {
  const existing = loadCredentials();
  if (!existing?.refresh_token && !existing?.access_token) {
    throw new CliError(
      "siwc_not_signed_in",
      "Not signed in to ChatGPT.",
      `Run co-maintainer oauth login --provider=${SIWC_PROVIDER} first.`,
      EXIT_USAGE,
    );
  }
  if (existing.expires_at - 60_000 > Date.now()) return existing;
  if (!existing.refresh_token) return existing;
  return refresh(existing);
}

export async function listModels(creds: Credentials): Promise<ModelInfo[]> {
  const url = `${apiBase()}/models`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${creds.access_token}` },
    });
  } catch (error) {
    throw networkFailure(url, error);
  }
  if (!response.ok) {
    throw new CliError(
      "siwc_models_failed",
      `ChatGPT returned ${response.status} while listing models.`,
      `If the token expired, run co-maintainer oauth login --provider=${SIWC_PROVIDER}.`,
      EXIT_RUNTIME,
    );
  }
  const json = (await response.json()) as Json;
  const listed = Array.isArray(json.models) ? (json.models as Json[]) : [];
  if (listed.length > 0) {
    return listed
      .filter((model) => model.visibility === "list" && model.slug)
      .map((model) => ({
        slug: String(model.slug),
        displayName: String(model.display_name ?? model.slug),
      }));
  }
  const data = Array.isArray(json.data) ? (json.data as Json[]) : [];
  return data
    .filter((model) => model.id)
    .map((model) => ({
      slug: String(model.id),
      displayName: String(model.id),
    }));
}

/** The model slugs a user can pick, for prompts and error messages. */
export async function availableModelSlugs(): Promise<string[]> {
  const creds = await ensureCredentials();
  return (await listModels(creds)).map((model) => model.slug);
}

function eligibilityHelp(): CliError {
  return new CliError(
    "siwc_ineligible",
    "ChatGPT denied access. This may be because the account has no paid ChatGPT subscription (Go, Plus or Pro is required).",
    `For details see ${HELP_URL}`,
  );
}

async function planError(
  creds: Credentials,
  model: string,
  status: number,
  body: string,
): Promise<CliError> {
  let code = "";
  let message = "";
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string; message?: string };
    };
    code = String(parsed.error?.code ?? "");
    message = String(parsed.error?.message ?? "");
  } catch {
    message = body.trim().slice(0, 200);
  }
  if (status === 401) {
    return new CliError(
      "siwc_unauthorized",
      "Sign in with ChatGPT rejected the token.",
      `Run co-maintainer oauth login --provider=${SIWC_PROVIDER} to sign in again.`,
      EXIT_USAGE,
    );
  }
  if (status === 403 && code.startsWith("subscription_sharing")) {
    return eligibilityHelp();
  }
  if ((status === 400 || status === 404) && code === "model_not_found") {
    const slugs = await listModels(creds).then(
      (models) => models.map((info) => info.slug),
      () => [],
    );
    return new CliError(
      "siwc_unknown_model",
      `This ChatGPT plan does not serve the model ${normalizeModel(model)}${message ? `: ${message}` : "."}`,
      slugs.length
        ? `Available models: ${slugs.join(", ")}. Set one with --low-model=... or --high-model=...`
        : undefined,
      EXIT_USAGE,
    );
  }
  return new CliError(
    "siwc_failed",
    `ChatGPT failed with ${status}${message ? `: ${message}` : "."}`,
    undefined,
    EXIT_RUNTIME,
  );
}

export class SignInWithChatGptProvider implements AiProvider {
  readonly supportsTools = true;
  private readonly model: string;

  constructor(model: string) {
    this.model = normalizeModel(model);
  }

  private async post(
    accessToken: string,
    request: AiRequest,
  ): Promise<Response> {
    const endpoint = `${apiBase()}/responses`;
    try {
      return await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          responsesBody(this.model, request, { planUsage: true }),
        ),
      });
    } catch (error) {
      throw networkFailure(endpoint, error);
    }
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    let creds = await ensureCredentials();
    let response = await this.post(creds.access_token, request);
    if (response.status === 401) {
      creds = await refresh(creds);
      response = await this.post(creds.access_token, request);
    }
    if (!response.ok) {
      const detail = await response.text();
      throw await planError(creds, this.model, response.status, detail);
    }
    const json = await readResponsesStream(response);
    if (json.status === "failed") {
      const error = (json.error ?? {}) as Json;
      throw await planError(
        creds,
        this.model,
        Number(error.status ?? 400),
        JSON.stringify({ error }),
      );
    }
    return parseResponsesBody(json, this.model, SIWC_PROVIDER);
  }
}
