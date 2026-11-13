/** Registration values: repository patterns, review types, timeouts, the
 * run-after cycle check and which registrations apply to a review. */
import { test } from "node:test";
import {
  applicableRegistrations,
  formatTimeout,
  matchesRepo,
  parseReviewTypes,
  parseTimeout,
  reposProblem,
  rerunsOnRestart,
  runAfterCycle,
  type ExtensionRegistration,
} from "./registry.ts";

function registration(
  overrides: Partial<ExtensionRegistration>,
): ExtensionRegistration {
  return {
    name: "x",
    command: "true",
    repos: "*",
    parallelism: true,
    priority: 0,
    failFast: false,
    retryOnFailTimes: 0,
    maxRequestedRetries: 3,
    timeoutSeconds: 600,
    ...overrides,
  };
}

test("repository patterns cover exactly what they name", () => {
  const cases: [string, string, boolean][] = [
    ["*", "acme/widgets", true],
    ["acme/widgets", "Acme/Widgets", true],
    ["acme/widgets", "acme/gadgets", false],
    ["acme/*", "acme/gadgets", true],
    ["acme/*", "other/gadgets", false],
    ["*/gadgets", "other/gadgets", true],
    ["a/b,acme/widgets", "acme/widgets", true],
  ];
  for (const [pattern, repo, want] of cases) {
    if (matchesRepo(pattern, repo) !== want) {
      throw new Error(`${pattern} vs ${repo}: wanted ${want}`);
    }
  }
  if (!reposProblem("acme")) throw new Error("a bare owner passed");
  if (!reposProblem("acme/widgets/x")) throw new Error("three parts passed");
  if (reposProblem("a/b, a/c,*/x")) throw new Error("a valid list failed");
});

test("review types and timeouts parse or say what is wrong", () => {
  const types = parseReviewTypes("pr,local,pr");
  if (JSON.stringify(types) !== '["pr","local"]')
    throw new Error(String(types));
  if (typeof parseReviewTypes("pr,ci") !== "string") {
    throw new Error("an unknown type passed");
  }
  if (parseTimeout("10m") !== 600 || parseTimeout("90") !== 90) {
    throw new Error("timeout parse");
  }
  if (typeof parseTimeout("7h") !== "string") throw new Error("7h passed");
  if (typeof parseTimeout("0s") !== "string") throw new Error("0s passed");
  if (formatTimeout(600) !== "10m" || formatTimeout(45) !== "45s") {
    throw new Error("timeout format");
  }
});

test("a run-after cycle is found, review never closes one", () => {
  const cycle = runAfterCycle([
    { name: "a", runAfter: "b" },
    { name: "b", runAfter: "c" },
    { name: "c", runAfter: "a" },
  ]);
  if (!cycle?.includes("a -> b -> c -> a")) throw new Error(String(cycle));
  const none = runAfterCycle([
    { name: "a", runAfter: "review" },
    { name: "b", runAfter: "a" },
    { name: "c", runAfter: "missing" },
  ]);
  if (none) throw new Error(none);
});

test("only enabled registrations for this repository and type apply", () => {
  const all = [
    registration({ name: "everywhere" }),
    registration({ name: "off", disabled: true }),
    registration({ name: "elsewhere", repos: "other/*" }),
    registration({ name: "local-only", reviewTypes: ["local"] }),
    registration({ name: "pr-only", reviewTypes: ["pr"] }),
  ];
  const names = applicableRegistrations(all, "acme/widgets", "pr").map(
    (entry) => entry.name,
  );
  if (names.join(",") !== "everywhere,pr-only") throw new Error(names.join());
});

test("rerun on restart: the registration wins, then the config key, then on", () => {
  if (!rerunsOnRestart({}, {})) throw new Error("default is not on");
  if (rerunsOnRestart({}, { extensionRerunOnRestart: false })) {
    throw new Error("the config key was ignored");
  }
  if (
    !rerunsOnRestart(
      { rerunOnRestart: true },
      { extensionRerunOnRestart: false },
    )
  ) {
    throw new Error("the registration did not win");
  }
});
