import { test } from "node:test";
import {
  SignInWithChatGptProvider,
  credentialsPath,
  ensureCredentials,
  listModels,
  login,
  normalizeModel,
  setBrowserOpener,
} from "./sign-in-with-chatgpt.ts";
import {
  EXPERIMENTAL_OAUTH_PROVIDER,
  resolveOAuthProvider,
} from "./registry.ts";
import { startFakeOAuth } from "../../testing/fake_oauth.ts";
import {
  deleteEnv,
  getEnv,
  makeTempDir,
  remove,
  setEnv,
  statSync,
} from "../../util/runtime.ts";

function withEnv(names: string[], values: Record<string, string>): () => void {
  const previous = new Map(names.map((name) => [name, getEnv(name)]));
  for (const [name, value] of Object.entries(values)) setEnv(name, value);
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) deleteEnv(name);
      else setEnv(name, value!);
    }
  };
}

test("normalizeModel strips only a leading openai/", () => {
  if (normalizeModel("openai/gpt-6-luna") !== "gpt-6-luna") {
    throw new Error(normalizeModel("openai/gpt-6-luna"));
  }
  if (normalizeModel("gpt-6-luna") !== "gpt-6-luna") {
    throw new Error(normalizeModel("gpt-6-luna"));
  }
  if (normalizeModel("anthropic/claude") !== "anthropic/claude") {
    throw new Error("a non-openai prefix must be left alone");
  }
});

test("resolveOAuthProvider takes the id and the siwc alias", () => {
  if (
    resolveOAuthProvider("sign-in-with-chatgpt") !== EXPERIMENTAL_OAUTH_PROVIDER
  ) {
    throw new Error("full id must resolve");
  }
  if (resolveOAuthProvider("siwc") !== EXPERIMENTAL_OAUTH_PROVIDER) {
    throw new Error("alias must resolve");
  }
  if (resolveOAuthProvider("nope") !== undefined) {
    throw new Error("an unknown provider must not resolve");
  }
});

test("Sign in with ChatGPT: login, model list, and a plan-usage call", async () => {
  const fake = await startFakeOAuth();
  const dir = await makeTempDir();
  const restore = withEnv(
    ["CM_SIWC_DIR", "CM_SIWC_AUTH_URL", "CM_SIWC_API_URL"],
    {
      CM_SIWC_DIR: dir,
      CM_SIWC_AUTH_URL: fake.url,
      CM_SIWC_API_URL: fake.url,
    },
  );
  setBrowserOpener((url) => {
    void fake.completeSignIn(url);
  });
  try {
    const creds = await login();
    if (creds.email !== "test@example.com") throw new Error(creds.email ?? "");
    // chmod is a no-op on Windows, so the 0600 check only applies on POSIX.
    if (process.platform !== "win32") {
      const mode = statSync(credentialsPath()).mode & 0o777;
      if (mode !== 0o600) throw new Error(`mode ${mode.toString(8)}`);
    }

    const models = await listModels(creds);
    if (models.length !== 1 || models[0]!.slug !== "gpt-6-luna") {
      throw new Error(JSON.stringify(models));
    }

    const provider = new SignInWithChatGptProvider("openai/gpt-6-luna");
    const response = await provider.complete({
      job: "test",
      prompt: "hi",
      maxTokens: 100,
    });
    if (response.text !== "Hello.") throw new Error(response.text);
    if (response.provider !== "sign-in-with-chatgpt") {
      throw new Error(response.provider);
    }
    if (response.tokensIn !== 3 || response.tokensOut !== 2) {
      throw new Error(JSON.stringify(response));
    }
    const body = fake.lastResponsesBody!;
    if (body.model !== "gpt-6-luna") {
      throw new Error(
        `the model prefix must be trimmed: ${String(body.model)}`,
      );
    }
    if (body.store !== false || body.stream !== true) {
      throw new Error(`plan usage needs store:false, stream:true`);
    }
    if ("max_output_tokens" in body) {
      throw new Error("the plan usage route rejects max_output_tokens");
    }
  } finally {
    setBrowserOpener(undefined);
    restore();
    await remove(dir, { recursive: true });
    await fake.close();
  }
});

test("Sign in with ChatGPT: a login timeout closes the callback server", async () => {
  const fake = await startFakeOAuth();
  const dir = await makeTempDir();
  const restore = withEnv(
    [
      "CM_SIWC_DIR",
      "CM_SIWC_AUTH_URL",
      "CM_SIWC_API_URL",
      "CM_SIWC_LOGIN_TIMEOUT_MS",
    ],
    {
      CM_SIWC_DIR: dir,
      CM_SIWC_AUTH_URL: fake.url,
      CM_SIWC_API_URL: fake.url,
      CM_SIWC_LOGIN_TIMEOUT_MS: "150",
    },
  );
  let redirectUri = "";
  setBrowserOpener((url) => {
    // Record the loopback port but never complete the sign-in.
    redirectUri = new URL(url).searchParams.get("redirect_uri") ?? "";
  });
  try {
    let timedOut = false;
    try {
      await login();
    } catch (error) {
      timedOut = /timed out/.test(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!timedOut) throw new Error("login should have timed out");
    let refused = false;
    try {
      await fetch(redirectUri);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error("the callback server is still listening");
  } finally {
    setBrowserOpener(undefined);
    restore();
    await remove(dir, { recursive: true });
    await fake.close();
  }
});

test("Sign in with ChatGPT: a 401 refresh is visible to later callers", async () => {
  const fake = await startFakeOAuth();
  const dir = await makeTempDir();
  const restore = withEnv(
    ["CM_SIWC_DIR", "CM_SIWC_AUTH_URL", "CM_SIWC_API_URL"],
    {
      CM_SIWC_DIR: dir,
      CM_SIWC_AUTH_URL: fake.url,
      CM_SIWC_API_URL: fake.url,
    },
  );
  setBrowserOpener((url) => {
    void fake.completeSignIn(url);
  });
  try {
    await login();
    // Resolve the shared credentials before the 401, so a stale cache is what
    // a later call would get if `refresh()` did not update it.
    const before = await ensureCredentials();
    if (before.access_token !== "access_1")
      throw new Error(before.access_token);

    fake.failNextResponses = true;
    const provider = new SignInWithChatGptProvider("gpt-6-luna");
    const response = await provider.complete({
      job: "test",
      prompt: "hi",
      maxTokens: 10,
    });
    if (response.text !== "Hello.") throw new Error(response.text);

    const after = await ensureCredentials();
    if (after.access_token !== "access_2") {
      throw new Error(`stale token after a refresh: ${after.access_token}`);
    }
  } finally {
    setBrowserOpener(undefined);
    restore();
    await remove(dir, { recursive: true });
    await fake.close();
  }
});

test("Sign in with ChatGPT: an unknown model names both model flags", async () => {
  const fake = await startFakeOAuth();
  const dir = await makeTempDir();
  const restore = withEnv(
    ["CM_SIWC_DIR", "CM_SIWC_AUTH_URL", "CM_SIWC_API_URL"],
    {
      CM_SIWC_DIR: dir,
      CM_SIWC_AUTH_URL: fake.url,
      CM_SIWC_API_URL: fake.url,
    },
  );
  setBrowserOpener((url) => {
    void fake.completeSignIn(url);
  });
  try {
    await login();
    const provider = new SignInWithChatGptProvider("unknown-model");
    let hint = "";
    try {
      await provider.complete({ job: "test", prompt: "hi", maxTokens: 10 });
    } catch (error) {
      hint = (error as { hint?: string }).hint ?? "";
    }
    if (!hint.includes("--low-model") || !hint.includes("--high-model")) {
      throw new Error(hint || "no hint");
    }
  } finally {
    setBrowserOpener(undefined);
    restore();
    await remove(dir, { recursive: true });
    await fake.close();
  }
});
