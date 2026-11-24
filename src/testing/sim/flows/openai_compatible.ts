/** `--ai=openai-compatible` (issue 162): one Chat Completions client for any
 * address, with the address rules and the serve egress guard.
 *
 * The simulated OpenRouter speaks Chat Completions, so it stands in for the
 * user's server: `set` points the base URL at it, `init` runs, and the flow
 * reads the bodies and headers that reached it. A new address drops the
 * saved key. With the serve guard on, an address that resolves to a private
 * or metadata IP is refused before anything is sent. The checks read the
 * requests, the config and the errors, never what the model answered. */
import {
  check,
  type CheckResult,
  type CliRun,
  defineFlow,
  type Sim,
} from "../flow.ts";
import { SAMPLE_REPO } from "../sample_repo.ts";
import { INIT_AI } from "./init.ts";

const REPO = "sim/compatible";
const SERVER = "https://openrouter.ai/api/v1";

const STEP = {
  set: "set points openai-compatible at a server",
  init: "init through the openai-compatible server",
  moved: "the base URL moves to another server",
  internal:
    "with the serve guard, a base URL that resolves to a private address",
  metadata: "with the serve guard, the cloud metadata address",
};

type Json = Record<string, unknown>;

const runAt = (sim: Sim, key: string) => sim.state[key] as CliRun;

function aiIn(sim: Sim, step: string) {
  return sim.trace.ai.filter((call) => call.step === step);
}

async function initWith(sim: Sim, repo = REPO): Promise<string> {
  const { runInitOrRemake } = await import("../../../services/setup.ts");
  try {
    await runInitOrRemake(
      sim.options({ command: "init", repo, ai: "openai-compatible" }),
    );
    return "finished";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** One request through the provider factory, as every job builds it. */
async function askOnce(sim: Sim): Promise<string> {
  const { createAiProvider } = await import("../../../ai/provider.ts");
  const options = sim.options({ ai: "openai-compatible" });
  try {
    await createAiProvider(options, options.highModel!)!.complete({
      prompt: "hello",
      maxTokens: 20,
      job: "egress_check",
    });
    return "answered";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function guarded<T>(sim: Sim, fn: () => Promise<T>): Promise<T> {
  const egress = await import("../../../ai/egress.ts");
  egress.setEgressResolverForTest(async (host) =>
    host === "internal.simulate.test" ? ["10.0.0.7"] : ["93.184.216.34"],
  );
  egress.setEgressGuard(true);
  try {
    return await fn();
  } finally {
    egress.setEgressGuard(false);
    egress.setEgressResolverForTest();
  }
}

function checks(sim: Sim): CheckResult[] {
  const calls = aiIn(sim, STEP.init);
  const bodies = calls.map((call) => call.request as Json);
  const keyed = sim.trace.credentials.filter(
    (use) => use.step === STEP.init && use.host === "openrouter.ai",
  );
  const config = sim.state.configAfterMove as Json | undefined;
  const internal = String(sim.state.internal ?? "");
  const metadata = String(sim.state.metadata ?? "");
  return [
    check(
      "set saves openai-compatible with the cleaned base URL",
      runAt(sim, "set").exitCode === 0 && sim.state.savedBase === SERVER,
      `exit ${runAt(sim, "set").exitCode} · base ${String(sim.state.savedBase)}`,
    ),
    check(
      "init reaches the server with Chat Completions: max_completion_tokens, temperature 0, no OpenRouter reasoning object, and the key in the header",
      sim.state.initResult === "finished" &&
        bodies.length > 0 &&
        bodies.every(
          (body) =>
            typeof body.max_completion_tokens === "number" &&
            body.temperature === 0 &&
            !("reasoning" in body) &&
            !("max_tokens" in body),
        ) &&
        keyed.length > 0,
      `${String(sim.state.initResult).slice(0, 80)} · ${bodies.length} requests · key sent ${keyed.length}`,
    ),
    check(
      "a new base URL drops the saved key",
      runAt(sim, "moved").exitCode === 0 &&
        config?.aiBaseUrl === "https://llm.example.test/v1" &&
        config.token === undefined,
      `base ${String(config?.aiBaseUrl)} · key ${config?.token === undefined ? "dropped" : "kept"}`,
    ),
    check(
      "with the serve guard, a private address is refused before any request, and the message names CM_AI_ALLOW_PRIVATE",
      /CM_AI_ALLOW_PRIVATE/.test(internal) &&
        aiIn(sim, STEP.internal).length === 0,
      `${internal.slice(0, 120)} · ${aiIn(sim, STEP.internal).length} requests`,
    ),
    check(
      "with the serve guard, the cloud metadata address is refused before any request",
      /CM_AI_ALLOW_PRIVATE/.test(metadata) &&
        aiIn(sim, STEP.metadata).length === 0,
      `${metadata.slice(0, 120)} · ${aiIn(sim, STEP.metadata).length} requests`,
    ),
  ];
}

export default defineFlow({
  name: "openai-compatible",
  description:
    "openai-compatible: set with a base URL, init through it with the Chat Completions body, a new address drops the key, and serve refuses private and metadata addresses",
  ai: INIT_AI,
  steps: [
    {
      name: STEP.set,
      async run(sim) {
        sim.repo(REPO, SAMPLE_REPO);
        const options = sim.options();
        sim.state.set = await sim.cli([
          "set",
          `--ai-base-url=${SERVER}/chat/completions`,
          `--ai-key=${options.aiToken}`,
          `--low-model=${options.lowModel}`,
          `--high-model=${options.highModel}`,
          "--no-verify",
        ]);
        sim.state.savedBase = sim.world.readConfig().aiBaseUrl;
        return `exit ${runAt(sim, "set").exitCode}`;
      },
    },
    {
      name: STEP.init,
      async run(sim) {
        sim.state.initResult = await initWith(sim);
        return String(sim.state.initResult).slice(0, 80);
      },
    },
    {
      name: STEP.moved,
      async run(sim) {
        sim.state.moved = await sim.cli([
          "set",
          "--ai-base-url=https://llm.example.test/v1",
          "--no-verify",
        ]);
        sim.state.configAfterMove = sim.world.readConfig();
        return `exit ${runAt(sim, "moved").exitCode}`;
      },
    },
    {
      name: STEP.internal,
      async run(sim) {
        sim.world.writeConfig({
          aiBaseUrl: "https://internal.simulate.test/v1",
        });
        sim.state.internal = await guarded(sim, () => askOnce(sim));
        return String(sim.state.internal).slice(0, 80);
      },
    },
    {
      name: STEP.metadata,
      async run(sim) {
        sim.world.writeConfig({
          aiBaseUrl: "http://169.254.169.254/v1",
          aiAllowHttp: true,
        });
        sim.state.metadata = await guarded(sim, () => askOnce(sim));
        return String(sim.state.metadata).slice(0, 80);
      },
    },
  ],
  checks,
});
