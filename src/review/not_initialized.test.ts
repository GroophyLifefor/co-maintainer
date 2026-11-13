import { test } from "node:test";
import { CliError, EXIT_USAGE } from "../cli/error.ts";
import { handshakeFailure } from "../remote/http.ts";
import {
  createCliHarness,
  writeHarnessConfig,
} from "../testing/cli_harness.ts";
import { readTextFile } from "../util/runtime.ts";
import { assertGuides, notInitializedError } from "./not_initialized.ts";

test("not_initialized: one code, exit code 2 and the init hint", () => {
  const error = notInitializedError("acme/widgets");
  if (error.code !== "not_initialized") throw new Error(error.code);
  if (error.exitCode !== EXIT_USAGE) throw new Error(`${error.exitCode}`);
  if (error.hint !== "co-maintainer init acme/widgets") {
    throw new Error(`${error.hint}`);
  }
  if (error.message !== "Review guides are missing for acme/widgets.") {
    throw new Error(error.message);
  }
});

test("not_initialized: a server is named, and the hint says to run init there", () => {
  const error = notInitializedError("acme/widgets", "review.example.com");
  if (!error.message.includes("on review.example.com")) {
    throw new Error(error.message);
  }
  if (
    error.hint !==
    "Run co-maintainer init acme/widgets on the server at review.example.com."
  ) {
    throw new Error(`${error.hint}`);
  }
  if (error.code !== "not_initialized" || error.exitCode !== EXIT_USAGE) {
    throw new Error(`${error.code} ${error.exitCode}`);
  }
});

test("not_initialized: either the short guide or the skill is enough", () => {
  assertGuides("acme/widgets", { shortGuide: "# Guide", skill: "" });
  assertGuides("acme/widgets", { shortGuide: "", skill: "# Skill" });
  let error: unknown;
  try {
    assertGuides("acme/widgets", { shortGuide: "", skill: "" });
  } catch (thrown) {
    error = thrown;
  }
  if (!(error instanceof CliError) || error.code !== "not_initialized") {
    throw new Error(`${error}`);
  }
});

function refusal(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("handshake refusal: a repository without guides is not_initialized", async () => {
  const error = await handshakeFailure(
    refusal(409, { error: { code: "not_initialized", message: "x" } }),
    "https://review.example.com/",
    "acme/widgets",
  );
  if (error.code !== "not_initialized" || error.exitCode !== EXIT_USAGE) {
    throw new Error(`${error.code} ${error.exitCode}`);
  }
  if (
    error.hint !==
    "Run co-maintainer init acme/widgets on the server at review.example.com."
  ) {
    throw new Error(`${error.hint}`);
  }
  if (!error.message.includes("review.example.com")) {
    throw new Error(error.message);
  }
});

test("handshake refusal: an unknown repository is told apart from missing guides", async () => {
  const error = await handshakeFailure(
    refusal(404, { error: { code: "repo_unavailable", message: "Sorry" } }),
    "https://review.example.com",
    "acme/widgets",
  );
  if (error.code !== "repo_unavailable" || error.exitCode !== EXIT_USAGE) {
    throw new Error(`${error.code} ${error.exitCode}`);
  }
  if (/init/.test(error.hint ?? "")) {
    throw new Error(
      `an unknown repository must not suggest init: ${error.hint}`,
    );
  }
});

test("handshake refusal: no code, or a code this client does not know, stays a handshake failure", async () => {
  for (const response of [
    refusal(409, "not json"),
    refusal(409, { error: { message: "Sorry, we could not access it." } }),
    refusal(500, { error: { code: "internal", message: "boom" } }),
  ]) {
    const error = await handshakeFailure(
      response,
      "https://review.example.com",
      "acme/widgets",
    );
    if (error.code !== "remote_handshake_failed") throw new Error(error.code);
    if (error.exitCode !== EXIT_USAGE) throw new Error(`${error.exitCode}`);
  }
});

test("handshake refusal: the server's text loses its control characters", async () => {
  const error = await handshakeFailure(
    refusal(502, {
      error: { message: "\u001b]52;c;aGk=\u0007bad\u001b[2J\rgateway" },
    }),
    "https://review.example.com",
    "acme/widgets",
  );
  if (error.message !== "]52;c;aGk=bad[2Jgateway") {
    throw new Error(JSON.stringify(error.message));
  }
});

// Pull request review, as a real process against the fake gh. The repository
// has no guides, so the run has to stop before it asks GitHub for anything.
for (const mode of ["json", "github", "human"] as const) {
  test(`pull request review: missing guides stop with not_initialized (${mode})`, async () => {
    const harness = await createCliHarness();
    try {
      await writeHarnessConfig(`${harness.home}/config/config.json`, {
        auth: "gh",
        ai: "openrouter",
        token: "fake-key",
        lowModel: "fake/model",
        highModel: "fake/model",
      });
      const result = await harness.run({
        args: [
          "review",
          "fixture/repo",
          "1",
          ...(mode === "json" ? ["--json"] : []),
          ...(mode === "github" ? ["--output=github"] : []),
        ],
        env: { CM_FAKE_AI: "1" },
      });
      if (result.code !== 2) {
        throw new Error(
          `exit ${result.code}\n${result.stdout}${result.stderr}`,
        );
      }
      const hint = "co-maintainer init fixture/repo";
      if (mode === "json") {
        const body = JSON.parse(result.stdout);
        if (body.ok !== false || body.error?.code !== "not_initialized") {
          throw new Error(result.stdout);
        }
        if (body.exitCode !== 2 || body.error.hint !== hint) {
          throw new Error(result.stdout);
        }
      } else {
        if (
          !result.stderr.includes("Review guides are missing for fixture/repo.")
        ) {
          throw new Error(result.stderr);
        }
        if (!result.stderr.includes(`Hint: ${hint}`)) {
          throw new Error(result.stderr);
        }
        if (result.stdout.trim() !== "") {
          throw new Error(`stdout must stay empty:\n${result.stdout}`);
        }
      }
      let calls = "";
      try {
        calls = await readTextFile(`${harness.home}/gh-calls.log`);
      } catch {
        // no log file means gh was never started
      }
      if (calls.trim() !== "") {
        throw new Error(`GitHub was called before the guide check:\n${calls}`);
      }
    } finally {
      await harness.cleanup();
    }
  });
}
