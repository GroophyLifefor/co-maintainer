/** `set --repo` stores the diagram settings in config.json, and the App's
 * review options read them back. */
import { test } from "node:test";
import { readConfig } from "../../config.ts";
import { reviewOptions } from "../../services/review.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import {
  deleteEnv,
  getEnv,
  setEnv,
  tempDirSync,
} from "../../testing/runtime.ts";
import { runSet } from "./set.ts";
import { isolateTestFile } from "../../testing/locations.ts";

// These tests resolve the config or cache directory. Keep both in a temp
// home of this file's own, never the developer's real ones.
isolateTestFile();

async function withConfig(fn: () => Promise<void>): Promise<void> {
  const original = getEnv("CM_CONFIG_PATH");
  const dir = tempDirSync();
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  try {
    await fn();
  } finally {
    if (original === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", original);
  }
}

async function refused(args: string[]): Promise<string> {
  try {
    await runSet(args);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`accepted ${args.join(" ")}`);
}

function same(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) {
    throw new Error(
      `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

test("set --repo stores the three diagram settings", async () => {
  await withConfig(async () => {
    await runSet([
      "--repo=acme/widgets",
      "--diagram-runtime=plantuml-server",
      "--plantuml-server=https://uml.example.com/plantuml",
      "--plantuml-output-format=png",
    ]);
    const stored = readConfig().repos?.["acme/widgets"];
    same(stored?.diagramRuntime, "plantuml-server", "runtime");
    same(stored?.plantumlServer, "https://uml.example.com/plantuml", "server");
    same(stored?.plantumlOutputFormat, "png", "format");
  });
});

test("an App review reads the repository's diagram settings", async () => {
  await withConfig(async () => {
    const originalDb = getEnv("CM_APP_DB");
    setEnv("CM_APP_DB", `${tempDirSync()}/app.db`);
    await openAppDb();
    try {
      const before = reviewOptions("acme/widgets", 1);
      same("diagramRuntime" in before, false, "unset runtime");
      await runSet(["--repo=acme/widgets", "--diagram-runtime=plantuml"]);
      const after = reviewOptions("acme/widgets", 1);
      same(after.diagramRuntime, "plantuml", "runtime");
      const other = reviewOptions("acme/other", 1);
      same("diagramRuntime" in other, false, "another repository");
    } finally {
      await closeAppDb();
      if (originalDb === undefined) deleteEnv("CM_APP_DB");
      else setEnv("CM_APP_DB", originalDb);
    }
  });
});

test("a setting with an invalid value is refused and nothing is written", async () => {
  await withConfig(async () => {
    same(
      await refused(["--repo=acme/widgets", "--diagram-runtime=dot"]),
      "--diagram-runtime must be one of: mermaid, plantuml, plantuml-server",
      "runtime",
    );
    const server = await refused([
      "--repo=acme/widgets",
      "--plantuml-server=ftp://uml.example.com",
    ]);
    if (!server.startsWith("--plantuml-server must be an http or https URL")) {
      throw new Error(server);
    }
    same(
      await refused(["--repo=acme/widgets", "--plantuml-output-format=gif"]),
      "--plantuml-output-format must be one of: svg, png",
      "format",
    );
    same(readConfig().repos?.["acme/widgets"], undefined, "written");
  });
});

test("the diagram flags need --repo", async () => {
  await withConfig(async () => {
    for (const flag of [
      "--diagram-runtime=plantuml",
      "--plantuml-server=https://uml.example.com",
      "--plantuml-output-format=png",
    ]) {
      same(
        await refused([flag]),
        `--${flag.slice(2).split("=")[0]} needs --repo`,
        flag,
      );
    }
  });
});

test("--unset clears one diagram setting and keeps the others", async () => {
  await withConfig(async () => {
    await runSet([
      "--repo=acme/widgets",
      "--diagram-runtime=plantuml-server",
      "--plantuml-output-format=png",
    ]);
    await runSet(["--repo=acme/widgets", "--unset=plantuml-output-format"]);
    const stored = readConfig().repos?.["acme/widgets"];
    same(stored?.plantumlOutputFormat, undefined, "format");
    same(stored?.diagramRuntime, "plantuml-server", "runtime kept");
    await runSet(["--repo=acme/widgets", "--unset=diagramRuntime"]);
    same(
      readConfig().repos?.["acme/widgets"]?.diagramRuntime,
      undefined,
      "runtime cleared",
    );
  });
});

test("--unset with a value in the same call sets the value", async () => {
  await withConfig(async () => {
    await runSet(["--repo=acme/widgets", "--diagram-runtime=plantuml"]);
    await runSet([
      "--repo=acme/widgets",
      "--unset=diagram-runtime",
      "--diagram-runtime=mermaid",
    ]);
    same(
      readConfig().repos?.["acme/widgets"]?.diagramRuntime,
      "mermaid",
      "runtime",
    );
  });
});

test("a diagram flag is still refused next to a global one with --repo", async () => {
  await withConfig(async () => {
    same(
      await refused(["--repo=acme/widgets", "--review-blocking=severity"]),
      "--review-blocking cannot be used with --repo",
      "global flag",
    );
  });
});
