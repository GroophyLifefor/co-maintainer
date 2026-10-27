import { test } from "node:test";
import {
  SignInWithChatGptProvider,
  credentialsPath,
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
    const mode = statSync(credentialsPath()).mode & 0o777;
    if (mode !== 0o600) throw new Error(`mode ${mode.toString(8)}`);

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
