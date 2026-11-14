/** A bad stored diagram setting must not stop a background job. */
import { test } from "node:test";
import { writeUserConfig } from "../config.ts";
import { closeAppDb, openAppDb } from "../store/app_db.ts";
import { serverDiagramOptions } from "../review/diagram.ts";
import { withLogSink } from "../util/log.ts";
import { reviewOptions } from "./review.ts";
import { deleteEnv, getEnv, setEnv, tempDirSync } from "../testing/runtime.ts";
import { isolateTestFile } from "../testing/locations.ts";

// These tests resolve the config or cache directory. Keep both in a temp
// home of this file's own, never the developer's real ones.
isolateTestFile();

async function withStore(
  repo: Record<string, unknown>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = { db: getEnv("CM_APP_DB"), config: getEnv("CM_CONFIG_PATH") };
  const dir = tempDirSync();
  setEnv("CM_APP_DB", `${dir}/app.db`);
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  await writeUserConfig({ repos: { "acme/widgets": repo } });
  await openAppDb();
  try {
    await fn();
  } finally {
    await closeAppDb();
    for (const [name, value] of [
      ["CM_APP_DB", saved.db],
      ["CM_CONFIG_PATH", saved.config],
    ] as const) {
      if (value === undefined) deleteEnv(name);
      else setEnv(name, value);
    }
  }
}

function same(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) {
    throw new Error(
      `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

test("a bad stored runtime falls back to mermaid with one warning", async () => {
  await withStore({ diagramRuntime: "d2" }, async () => {
    const warnings: string[] = [];
    const options = reviewOptions("acme/widgets", 1, (text) =>
      warnings.push(text),
    );
    same("diagramRuntime" in options, false, "runtime");
    same(warnings.length, 1, "warnings");
    if (!warnings[0]!.includes("repos[acme/widgets].diagramRuntime")) {
      throw new Error(warnings[0]);
    }
    if (!warnings[0]!.includes("mermaid")) throw new Error(warnings[0]);
  });
});

test("a good PlantUML server runtime with a bad server never reaches the default server", async () => {
  await withStore(
    {
      diagramRuntime: "plantuml-server",
      plantumlServer: "ftp://uml.example.com",
      plantumlOutputFormat: "png",
    },
    async () => {
      const warnings: string[] = [];
      const options = reviewOptions("acme/widgets", 1, (text) =>
        warnings.push(text),
      );
      // Mermaid, with nothing left over that could name a server.
      same("diagramRuntime" in options, false, "runtime");
      same("plantumlServer" in options, false, "server");
      same("plantumlOutputFormat" in options, false, "format");
      same(warnings.length, 1, "warnings");
      if (!warnings[0]!.includes("plantumlServer"))
        throw new Error(warnings[0]);
    },
  );
});

test("a good stored setting is used and warns about nothing", async () => {
  await withStore({ diagramRuntime: "plantuml" }, async () => {
    const warnings: string[] = [];
    const options = reviewOptions("acme/widgets", 1, (text) =>
      warnings.push(text),
    );
    same(options.diagramRuntime, "plantuml", "runtime");
    same(warnings.length, 0, "warnings");
  });
});

test("without a warn function the warning reaches the job log", async () => {
  await withStore({ plantumlOutputFormat: "gif" }, async () => {
    const lines: string[] = [];
    await withLogSink(
      (phase, message) => lines.push(`${phase}: ${message}`),
      async () => {
        reviewOptions("acme/widgets", 1);
      },
    );
    same(lines.length, 1, "log lines");
    if (!lines[0]!.includes("plantumlOutputFormat")) throw new Error(lines[0]);
  });
});

test("the helper returns no settings for a bad value and does not throw", () => {
  const seen: string[] = [];
  const options = serverDiagramOptions(
    { plantumlServer: "not a url" },
    "acme/widgets",
    (text) => seen.push(text),
  );
  same(JSON.stringify(options), "{}", "options");
  same(seen.length, 1, "warnings");
});
