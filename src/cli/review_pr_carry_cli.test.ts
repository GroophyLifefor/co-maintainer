/** `co-maintainer review owner/repo N` run twice, as a real process.
 *
 * The engine and the carry-over are covered in `pr_carry.test.ts`. This pins
 * what a person sees: the second run's `--json` summary and human output say
 * `closed`, `open` and `new`, and `--fresh` is accepted for a pull request and
 * starts over. GitHub is a small script that answers from a state file the test
 * edits between runs, the model is the fake OpenRouter.
 */
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  envToObject,
  makeTempDir,
  mkdir,
  remove,
  writeTextFile,
} from "../util/runtime.ts";
import {
  Command,
  runtimeExecPath,
  runtimeRunArgs,
} from "../testing/runtime.ts";
import { startFakeOpenRouter } from "../testing/fake_openrouter.ts";

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Plain .mjs: it runs as its own process, without the type-stripping loader. */
const FAKE_GH = `
import { readFileSync } from "node:fs";
const state = JSON.parse(readFileSync(process.env.CM_PR_STATE, "utf8"));
const args = process.argv.slice(2);
const endpoint = args.find((a, i) => i > 0 && !a.startsWith("-")) ?? "";
const path = endpoint.split("?")[0];
function out(body) { process.stdout.write(JSON.stringify(body) + "\\n"); }
if (/\\/compare\\//.test(path)) {
  if (state.compare === "missing") { process.stderr.write("gh: Not Found (HTTP 404)\\n"); process.exit(1); }
  out({ status: state.compare });
} else if (/\\/pulls\\/7\\/files$/.test(path)) {
  out(args.join(" ").includes("page=2") ? [] : state.files);
} else if (/\\/pulls\\/7$/.test(path)) {
  out({ title: "Add things", body: "", head: { sha: state.head }, base: { ref: "main", sha: "base0" } });
} else if (/\\/(comments|reviews)$/.test(path)) {
  out([]);
} else {
  process.stderr.write("gh: Not Found (HTTP 404)\\n");
  process.exit(1);
}
`;

function file(path: string, lines: string[]) {
  return {
    filename: path,
    status: "added",
    additions: lines.length,
    deletions: 0,
    changes: lines.length,
    patch: `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`,
  };
}

const A = ["const a = read()", "use(a.value)", "done()"];
const B = ["const b = read()", "use(b.value)", "done()"];
const C = ["const c = read()", "use(c.value)", "done()"];

function finding(path: string, title: string) {
  return {
    severity: "P2",
    blocking: false,
    path,
    lineFrom: 2,
    lineTo: 2,
    title,
    body: `${title}. The value is never validated before it is used.`,
  };
}

type Summary = { new: number; open: number; closed: number };
type Row = { path: string | null; state: string };

test("a CLI pull request review run twice reports closed, open and new", async () => {
  const root = await makeTempDir({ prefix: "cm-pr-carry-" });
  let run = 1;
  const server = await startFakeOpenRouter("success", {
    chatContent: (prompt) => {
      if (run === 1) {
        return JSON.stringify({
          findings: [
            finding("a.ts", "The first value is not validated"),
            finding("b.ts", "The second value is not validated"),
          ],
        });
      }
      if (run === 2) {
        return JSON.stringify({
          findings: [finding("c.ts", "The third value is not validated")],
          previousFindings: [{ id: "F1", state: "closed" }],
        });
      }
      // The --fresh run must not be shown the earlier findings.
      if (/PREVIOUS FINDINGS/.test(prompt)) {
        throw new Error("a --fresh run was handed the earlier findings");
      }
      return JSON.stringify({
        findings: [finding("c.ts", "The third value is not validated")],
      });
    },
  });
  try {
    const repo = "acme/widgets";
    await mkdir(`${root}/repos/${repo}`, { recursive: true });
    await writeTextFile(
      `${root}/repos/${repo}/PR_REVIEW_GUIDE.md`,
      "# Review guide\n\nValidate values.\n",
    );
    const configPath = `${root}/config.json`;
    await writeTextFile(
      configPath,
      `${JSON.stringify({
        auth: "gh",
        ai: "openrouter",
        token: "fake-key",
        lowModel: "fake/model",
        highModel: "fake/model",
      })}\n`,
    );
    await writeTextFile(`${root}/gh.mjs`, FAKE_GH);
    const statePath = `${root}/state.json`;
    const setState = (state: unknown) =>
      writeTextFile(statePath, JSON.stringify(state));

    const review = async (extra: string[]) => {
      const result = await new Command(runtimeExecPath(), {
        args: runtimeRunArgs(join(projectRoot, "main.ts"), [
          "review",
          repo,
          "7",
          "--disable-codegraph",
          "--review-upstream",
          ...extra,
        ]),
        cwd: root,
        env: {
          ...envToObject(),
          CM_CONFIG_PATH: configPath,
          CM_REPOS_DIR: `${root}/repos`,
          CM_OPENROUTER_URL: server.url,
          CM_GH_BIN: process.execPath,
          CM_GH_SCRIPT: `${root}/gh.mjs`,
          CM_PR_STATE: statePath,
          CM_APP_DB: `${root}/app.db`,
          LOCALAPPDATA: `${root}/localappdata`,
          XDG_CACHE_HOME: `${root}/cache`,
          CM_FAKE_AI: undefined,
          CM_FAKE_REVIEW_FILE: undefined,
        },
        stdout: "piped",
        stderr: "piped",
        timeoutMs: 60_000,
      }).output();
      return {
        code: result.code,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
      };
    };
    const summaryOf = (stdout: string): Summary =>
      (JSON.parse(stdout) as { summary: Summary }).summary;
    const rowsOf = (stdout: string): Row[] =>
      (JSON.parse(stdout) as { findings: Row[] }).findings;

    await setState({
      head: "sha1",
      compare: "ahead",
      files: [file("a.ts", A), file("b.ts", B)],
    });
    const first = await review(["--json"]);
    const s1 = summaryOf(first.stdout);
    if (s1.new !== 2 || s1.open !== 0 || s1.closed !== 0) {
      throw new Error(`run 1: ${first.stdout}${first.stderr}`);
    }

    // The author fixed a.ts, left b.ts alone and added c.ts.
    run = 2;
    await setState({
      head: "sha2",
      compare: "ahead",
      files: [
        file("a.ts", ["const a = validate(read())", "use(a.value)", "done()"]),
        file("b.ts", B),
        file("c.ts", C),
      ],
    });
    const second = await review(["--json"]);
    const s2 = summaryOf(second.stdout);
    if (s2.new !== 1 || s2.open !== 1 || s2.closed !== 1) {
      throw new Error(`run 2: ${second.stdout}${second.stderr}`);
    }
    const byPath = Object.fromEntries(
      rowsOf(second.stdout).map((row) => [row.path, row.state]),
    );
    if (
      byPath["a.ts"] !== "closed" ||
      byPath["b.ts"] !== "open" ||
      byPath["c.ts"] !== "new"
    ) {
      throw new Error(`run 2 states: ${JSON.stringify(byPath)}`);
    }

    // --fresh on a pull request: accepted, and nothing is carried.
    run = 3;
    const third = await review(["--fresh"]);
    if (
      third.code === 2 ||
      /Unknown option|not supported/i.test(third.stderr)
    ) {
      throw new Error(`--fresh was refused: ${third.stderr}`);
    }
    if (!/Summary: 1 new · 0 open · 0 closed/.test(third.stdout)) {
      throw new Error(`run 3: ${third.stdout}${third.stderr}`);
    }
  } finally {
    await server.close();
    await remove(root, { recursive: true });
  }
});
