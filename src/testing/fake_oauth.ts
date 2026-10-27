/** A local stand-in for the Sign in with ChatGPT endpoints and the plan
 * usage API, for tests. It signs a real id_token with a throwaway RSA key and
 * publishes the matching JWKS, so the flow's signature check runs for real.
 *
 * `completeSignIn` plays the browser: it follows the authorize redirect to the
 * loopback callback. Tests install it with `setBrowserOpener`. */
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeOAuth = {
  url: string;
  requests: string[];
  lastResponsesBody?: Record<string, unknown>;
  /** Set to true to make the next `/responses` call return 401, so a test can
   * exercise the refresh-on-401 path. */
  failNextResponses: boolean;
  completeSignIn(authorizeUrl: string): Promise<void>;
  close(): Promise<void>;
};

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startFakeOAuth(): Promise<FakeOAuth> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...(publicKey.export({ format: "jwk" }) as object),
    kid: "test",
  };
  const pending = new Map<string, { nonce: string }>();
  const state: {
    requests: string[];
    lastResponsesBody?: Record<string, unknown>;
  } = {
    requests: [],
  };
  let failNextResponses = false;
  let tokenCalls = 0;

  let base = "";

  const signIdToken = (payload: Record<string, unknown>): string => {
    const header = { alg: "RS256", kid: "test", typ: "JWT" };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(
      JSON.stringify(payload),
    )}`;
    const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey);
    return `${signingInput}.${b64url(signature)}`;
  };

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", base);
    const json = (value: unknown, status = 200): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };

    if (url.pathname === "/.well-known/openid-configuration") {
      json({ jwks_uri: `${base}/jwks` });
      return;
    }
    if (url.pathname === "/jwks") {
      json({ keys: [jwk] });
      return;
    }
    if (url.pathname === "/api/accounts/authorize") {
      const code = `code_${Math.random().toString(36).slice(2)}`;
      pending.set(code, { nonce: url.searchParams.get("nonce") ?? "" });
      const redirect = url.searchParams.get("redirect_uri") ?? "";
      const location = `${redirect}?code=${code}&state=${
        url.searchParams.get("state") ?? ""
      }&client_id=oaiapp_test`;
      response.writeHead(302, { location });
      response.end();
      return;
    }
    if (url.pathname === "/api/accounts/oauth/token") {
      const params = new URLSearchParams(await readBody(request));
      const clientId = params.get("client_id") ?? "";
      const grant = params.get("grant_type");
      const nonce =
        grant === "authorization_code"
          ? (pending.get(params.get("code") ?? "")?.nonce ?? "")
          : "";
      const idToken = signIdToken({
        iss: base,
        aud: clientId,
        sub: "user_test",
        email: "test@example.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce,
      });
      tokenCalls += 1;
      json({
        access_token: `access_${tokenCalls}`,
        refresh_token: `refresh_${tokenCalls}`,
        id_token: idToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope:
          "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      });
      return;
    }
    if (url.pathname === "/models") {
      if (
        !String(request.headers.authorization ?? "").startsWith(
          "Bearer access_",
        )
      ) {
        json({ error: { code: "unauthorized" } }, 401);
        return;
      }
      json({
        models: [
          {
            slug: "gpt-6-luna",
            display_name: "GPT-6-Luna",
            visibility: "list",
          },
          { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
        ],
      });
      return;
    }
    if (url.pathname === "/responses") {
      const body = await readBody(request);
      state.lastResponsesBody = JSON.parse(body) as Record<string, unknown>;
      if (state.lastResponsesBody.model === "unknown-model") {
        json(
          { error: { code: "model_not_found", message: "no such model" } },
          400,
        );
        return;
      }
      if (failNextResponses) {
        failNextResponses = false;
        json({ error: { code: "unauthorized" } }, 401);
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ type: "response.created" })}\n\n`,
      );
      // The plan usage route sends the output as its own item event and an
      // empty `output` on the terminal response, unlike the standard API.
      response.write(
        `data: ${JSON.stringify({
          type: "response.output_item.done",
          item: {
            type: "message",
            content: [{ type: "output_text", text: "Hello." }],
          },
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            status: "completed",
            output: [],
            usage: { input_tokens: 3, output_tokens: 2 },
          },
        })}\n\n`,
      );
      response.end();
      return;
    }
    if (url.pathname === "/error-status") {
      json({ error: { code: "subscription_sharing_user_not_eligible" } }, 403);
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;

  return {
    url: base,
    get requests() {
      return state.requests;
    },
    get lastResponsesBody() {
      return state.lastResponsesBody;
    },
    get failNextResponses() {
      return failNextResponses;
    },
    set failNextResponses(value: boolean) {
      failNextResponses = value;
    },
    async completeSignIn(authorizeUrl: string): Promise<void> {
      const redirect = await fetch(authorizeUrl, { redirect: "manual" });
      const location = redirect.headers.get("location");
      if (location) await fetch(location);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
