/** The one call each review mode makes: a failure to prepare the extensions
 * never fails the review, and the command runs in the run folder. */
import { test } from "node:test";
import {
  deleteEnv,
  getEnv,
  readTextFile,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../testing/runtime.ts";
import { withExtensions, type ReviewContext } from "./session.ts";
import { extensionsRoot } from "./run_folder.ts";

const posixOnly = { skip: process.platform === "win32" };

async function withConfig(
  command: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const saved = ["CM_CONFIG_PATH", "CM_EXTENSIONS_DISABLED"].map(
    (name) => [name, getEnv(name)] as const,
  );
  const dir = tempDirSync();
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  deleteEnv("CM_EXTENSIONS_DISABLED");
  await writeTextFile(
    `${dir}/config.json`,
    JSON.stringify({ extensions: [{ name: "probe", command }] }),
  );
  try {
    await fn(dir);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) deleteEnv(name);
      else setEnv(name, value);
    }
  }
}

function context(overrides: Partial<ReviewContext>): ReviewContext {
  return {
    owner: "serve",
    reviewType: "pr",
    repo: "acme/widgets",
    prNumber: 1,
    branch: null,
    workdir: "",
    headSha: null,
    baseSha: null,
    scope: "whole-pr",
    sinceCommit: null,
    trigger: "opened",
    round: 1,
    diff: () => "",
    ...overrides,
  };
}

test("a diff that cannot be built fails the extensions, not the review", async () => {
  await withConfig("true", async () => {
    const { review, extensions } = await withExtensions(
      context({
        diff: () => {
          throw new Error("GitHub said no");
        },
      }),
      async () => "the review",
      () => ({}),
    );
    if (review !== "the review") throw new Error(String(review));
    const result = extensions.results[0];
    if (
      result?.status !== "failed" ||
      !result.reason?.includes("GitHub said no")
    ) {
      throw new Error(JSON.stringify(extensions));
    }
  });
});

test(
  "outside a local review the command runs in its run folder",
  posixOnly,
  async () => {
    await withConfig("", async (dir) => {
      await writeTextFile(
        `${dir}/config.json`,
        JSON.stringify({
          extensions: [
            {
              name: "probe",
              command: `pwd > '${dir}/cwd'; echo '{"schemaVersion":1,"name":"p","status":"ok","verdict":"comment"}'`,
            },
          ],
        }),
      );
      const { extensions } = await withExtensions(
        context({}),
        async () => "done",
        () => ({}),
      );
      if (extensions.results[0]?.status !== "ok") {
        throw new Error(JSON.stringify(extensions));
      }
      const cwd = (await readTextFile(`${dir}/cwd`)).trim();
      if (!cwd.startsWith(extensionsRoot())) throw new Error(cwd);
    });
  },
);
