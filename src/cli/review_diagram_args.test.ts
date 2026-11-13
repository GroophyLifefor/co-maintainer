/** The diagram flags on `review`, and the repository setting under them. */
import { test } from "node:test";
import { parseArgs, setCliInteractive } from "./args.ts";
import { parseReviewArgs } from "./review_args.ts";
import { writeUserConfig } from "../config.ts";
import {
  deleteEnv,
  getEnv,
  makeTempDir,
  remove,
  setEnv,
} from "../util/runtime.ts";

const BASE = [
  "--token=test",
  "--low-model=low/model",
  "--high-model=test/model",
];

async function withConfig(fn: () => Promise<void>): Promise<void> {
  const dir = await makeTempDir({ prefix: "cm-diagram-args-" });
  const previous = getEnv("CM_CONFIG_PATH");
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  setCliInteractive(false);
  try {
    await fn();
  } finally {
    setCliInteractive(true);
    if (previous === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", previous);
    await remove(dir, { recursive: true });
  }
}

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (thrown) {
    return thrown instanceof Error ? thrown.message : String(thrown);
  }
  throw new Error("was accepted");
}

function same(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) {
    throw new Error(
      `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

test("review without a diagram setting leaves the options untouched", async () => {
  await withConfig(async () => {
    const options = await parseArgs(["review", "owner/repo", ...BASE]);
    same("diagramRuntime" in options, false, "runtime key");
    same("plantumlServer" in options, false, "server key");
    same("plantumlOutputFormat" in options, false, "format key");
  });
});

test("review takes the three diagram flags", async () => {
  await withConfig(async () => {
    const parsed = await parseReviewArgs([
      "owner/repo",
      "42",
      "--diagram-runtime=plantuml-server",
      "--plantuml-server=https://uml.example.com/plantuml",
      "--plantuml-output-format=png",
      ...BASE,
    ]);
    if (parsed.mode !== "pr") throw new Error(`mode ${parsed.mode}`);
    same(parsed.options.diagramRuntime, "plantuml-server", "runtime");
    same(
      parsed.options.plantumlServer,
      "https://uml.example.com/plantuml",
      "server",
    );
    same(parsed.options.plantumlOutputFormat, "png", "format");
  });
});

test("a local review reads the same flags", async () => {
  await withConfig(async () => {
    const options = await parseArgs([
      "review",
      "owner/repo",
      "--diagram-runtime=plantuml",
      ...BASE,
    ]);
    same(options.diagramRuntime, "plantuml", "runtime");
  });
});

test("the repository's stored setting applies, and a flag beats it", async () => {
  await withConfig(async () => {
    await writeUserConfig({
      repos: {
        "owner/repo": {
          diagramRuntime: "plantuml-server",
          plantumlServer: "https://uml.example.com",
          plantumlOutputFormat: "png",
        },
      },
    });
    const stored = await parseArgs(["review", "owner/repo", ...BASE]);
    same(stored.diagramRuntime, "plantuml-server", "stored runtime");
    same(stored.plantumlServer, "https://uml.example.com", "stored server");
    same(stored.plantumlOutputFormat, "png", "stored format");
    const flagged = await parseArgs([
      "review",
      "owner/repo",
      "--diagram-runtime=mermaid",
      ...BASE,
    ]);
    same(flagged.diagramRuntime, "mermaid", "flag runtime");
    same(
      flagged.plantumlOutputFormat,
      "png",
      "the rest still comes from the repository",
    );
  });
});

test("a bad runtime, server or format is a usage error", async () => {
  await withConfig(async () => {
    same(
      await refusal(() =>
        parseArgs(["review", "owner/repo", "--diagram-runtime=dot", ...BASE]),
      ),
      "--diagram-runtime must be one of: mermaid, plantuml, plantuml-server",
      "runtime",
    );
    for (const server of [
      "ftp://uml.example.com",
      "uml.example.com",
      "file:///tmp/x",
      "",
    ]) {
      const message = await refusal(() =>
        parseArgs([
          "review",
          "owner/repo",
          `--plantuml-server=${server}`,
          ...BASE,
        ]),
      );
      if (
        !message.startsWith("--plantuml-server must be an http or https URL")
      ) {
        throw new Error(`${server}: ${message}`);
      }
    }
    same(
      await refusal(() =>
        parseArgs([
          "review",
          "owner/repo",
          "--plantuml-output-format=gif",
          ...BASE,
        ]),
      ),
      "--plantuml-output-format must be one of: svg, png",
      "format",
    );
  });
});

test("a bad stored setting stops the review and names the repository", async () => {
  await withConfig(async () => {
    await writeUserConfig({
      repos: { "owner/repo": { plantumlServer: "ftp://old.example.com" } },
    });
    const message = await refusal(() =>
      parseArgs(["review", "owner/repo", ...BASE]),
    );
    if (!message.includes("repos[owner/repo].plantumlServer")) {
      throw new Error(message);
    }
  });
});

test("only review takes the diagram flags", async () => {
  await withConfig(async () => {
    const message = await refusal(() =>
      parseArgs(["sync", "owner/repo", "--diagram-runtime=plantuml", ...BASE]),
    );
    if (!message.startsWith("Unknown option: --diagram-runtime")) {
      throw new Error(message);
    }
  });
});

test("--remote refuses a diagram flag instead of dropping it", async () => {
  await withConfig(async () => {
    for (const flag of [
      "--diagram-runtime=plantuml",
      "--plantuml-server=https://uml.example.com",
      "--plantuml-output-format=png",
    ]) {
      const message = await refusal(() => parseReviewArgs(["--remote", flag]));
      if (!message.includes("cannot be used with --remote")) {
        throw new Error(message);
      }
      if (!message.startsWith(flag.split("=")[0]!)) throw new Error(message);
    }
  });
});
