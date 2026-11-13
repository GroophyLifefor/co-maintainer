/** `co-maintainer extension register | update | list | remove | disable |
 * enable | debug-run`.
 *
 * Management is CLI only. Every write goes through `config.json`, so `serve`
 * picks a change up on its next review without a restart. */
import { CliError, die, EXIT_RUNTIME, exitWith } from "../cli/error.ts";
import { askConfirm } from "../cli/prompt.ts";
import { canPrompt } from "../tools/codegraph.ts";
import { renderCommandHelp } from "../cli/commands/registry.ts";
import { configPath } from "../config.ts";
import {
  DEFAULT_MAX_REQUESTED_RETRIES,
  DEFAULT_TIMEOUT_SECONDS,
  DISABLED_MESSAGE,
  extensionsDisabled,
  formatTimeout,
  LIMITS,
  MAX_PRIORITY,
  nameProblem,
  parseBoolean,
  parseCount,
  parseReviewTypes,
  parseTimeout,
  readRegistrations,
  reposProblem,
  rerunsOnRestart,
  REVIEW_TARGET,
  runAfterCycle,
  writeRegistrations,
  type ExtensionRegistration,
} from "./registry.ts";
import { substitute, unknownVariables } from "./process.ts";
import { dependencyOf, runAttempts } from "./runner.ts";
import {
  openRunFolder,
  removeRunFolder,
  writeReviewResult,
} from "./run_folder.ts";
import { MOCK_DETAILS, MOCK_DIFF, MOCK_REVIEW_RESULT } from "./mock.ts";
import { buildReport } from "./report.ts";
import { cliExtensionFooter, cliExtensionLines } from "./render_cli.ts";
import { stripControlChars } from "../util/sanitize.ts";

const SUBCOMMANDS = [
  "register",
  "update",
  "list",
  "remove",
  "disable",
  "enable",
  "debug-run",
] as const;

/** Flags each subcommand accepts, without the leading dashes. */
const SETTING_FLAGS = [
  "command",
  "repos",
  "review-types",
  "run-after",
  "parallelism",
  "priority",
  "fail-fast",
  "retry-on-fail-times",
  "max-requested-retries",
  "timeout",
  "rerun-on-restart",
];
const ACCEPTED: Record<string, string[]> = {
  register: ["name", ...SETTING_FLAGS, "yes"],
  update: ["name", ...SETTING_FLAGS, "yes"],
  list: ["json"],
  remove: ["name"],
  disable: ["name"],
  enable: ["name"],
  "debug-run": ["name", "command"],
};

type Flags = Map<string, string | true>;

function parseFlags(sub: string, args: string[]): Flags {
  const flags: Flags = new Map();
  const accepted = ACCEPTED[sub] ?? [];
  for (const arg of args) {
    if (!arg.startsWith("--")) die(`Unexpected argument: ${arg}`);
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (!accepted.includes(name)) {
      die(`Unknown option for extension ${sub}: --${name}`);
    }
    flags.set(name, eq === -1 ? true : arg.slice(eq + 1));
  }
  return flags;
}

function stringFlag(flags: Flags, name: string): string | undefined {
  const value = flags.get(name);
  if (value === true) die(`--${name} needs a value: --${name}=...`);
  return value;
}

function requiredName(flags: Flags): string {
  const name = stringFlag(flags, "name");
  if (!name) die("--name is required");
  return name;
}

/** A parsed value, or the problem a parser returned, which ends the command. */
function valid<T>(value: T | string): T {
  if (typeof value === "string") die(value);
  return value;
}

/** Applies the setting flags on top of `base`. Only the flags given change
 * anything, so `update` keeps every other value. */
function applySettings(
  base: ExtensionRegistration,
  flags: Flags,
): ExtensionRegistration {
  const next: ExtensionRegistration = { ...base };
  const command = stringFlag(flags, "command");
  if (command !== undefined) {
    if (command.trim() === "") die("--command cannot be empty");
    const unknown = unknownVariables(command);
    if (unknown.length > 0) {
      die(
        `--command uses an unknown variable: {{${unknown[0]}}}. Known: {{details_path}}, {{review_result_path}}, {{diff_path}}`,
      );
    }
    next.command = command;
  }
  const repos = stringFlag(flags, "repos");
  if (repos !== undefined) {
    const problem = reposProblem(repos);
    if (problem) die(problem);
    next.repos = repos
      .split(",")
      .map((entry) => entry.trim())
      .join(",");
  }
  const types = stringFlag(flags, "review-types");
  if (types !== undefined) {
    next.reviewTypes =
      types === "all" ? undefined : valid(parseReviewTypes(types));
  }
  const runAfter = stringFlag(flags, "run-after");
  if (runAfter !== undefined) {
    next.runAfter =
      runAfter === "" || runAfter === "none" ? undefined : runAfter;
  }
  const parallelism = stringFlag(flags, "parallelism");
  if (parallelism !== undefined) {
    next.parallelism = valid(parseBoolean(parallelism, "--parallelism"));
  }
  const priority = stringFlag(flags, "priority");
  if (priority !== undefined) {
    next.priority = valid(parseCount(priority, "--priority", MAX_PRIORITY));
  }
  const failFast = flags.get("fail-fast");
  if (failFast !== undefined) {
    next.failFast =
      failFast === true ? true : valid(parseBoolean(failFast, "--fail-fast"));
  }
  const retries = stringFlag(flags, "retry-on-fail-times");
  if (retries !== undefined) {
    next.retryOnFailTimes = valid(
      parseCount(retries, "--retry-on-fail-times", LIMITS.maxRetries),
    );
  }
  const requested = stringFlag(flags, "max-requested-retries");
  if (requested !== undefined) {
    next.maxRequestedRetries = valid(
      parseCount(requested, "--max-requested-retries", LIMITS.maxRetries),
    );
  }
  const timeout = stringFlag(flags, "timeout");
  if (timeout !== undefined) {
    next.timeoutSeconds = valid(parseTimeout(timeout));
  }
  const rerun = stringFlag(flags, "rerun-on-restart");
  if (rerun !== undefined) {
    next.rerunOnRestart = valid(parseBoolean(rerun, "--rerun-on-restart"));
  }
  return next;
}

/** The run-after target must not close a cycle, and a name nobody registered
 * is most likely a typo, so it is asked about. */
async function checkRunAfter(
  registration: ExtensionRegistration,
  all: ExtensionRegistration[],
  yes: boolean,
): Promise<void> {
  const target = registration.runAfter;
  if (target === registration.name) {
    die("--run-after cannot name the extension itself");
  }
  const cycle = runAfterCycle(all);
  if (cycle) die(`--run-after would make a cycle: ${cycle}`);
  if (
    !target ||
    target === REVIEW_TARGET ||
    all.some((entry) => entry.name === target)
  ) {
    return;
  }
  const question = `No extension named "${target}" is registered. Until one is, ${registration.name} is skipped. Are you sure?`;
  if (yes) return;
  if (!canPrompt()) {
    throw new CliError(
      "usage",
      `No extension named "${target}" is registered.`,
      "Register it first, or pass --yes to save the run-after anyway.",
    );
  }
  if (!(await askConfirm(question))) die("Nothing was saved.");
}

const DEFAULTS: Omit<ExtensionRegistration, "name" | "command"> = {
  repos: "*",
  parallelism: true,
  priority: 0,
  failFast: false,
  retryOnFailTimes: 0,
  maxRequestedRetries: DEFAULT_MAX_REQUESTED_RETRIES,
  timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
};

async function register(flags: Flags): Promise<void> {
  if (extensionsDisabled()) {
    throw new CliError("extensions_disabled", DISABLED_MESSAGE);
  }
  const name = requiredName(flags);
  const problem = nameProblem(name);
  if (problem) die(problem);
  if (!flags.has("command")) die("--command is required");
  const all = readRegistrations();
  if (all.some((entry) => entry.name === name)) {
    die(
      `An extension named ${name} is already registered. Use extension update to change it.`,
    );
  }
  const registration = applySettings({ name, command: "", ...DEFAULTS }, flags);
  const next = [...all, registration];
  await checkRunAfter(registration, next, flags.has("yes"));
  await writeRegistrations(next);
  console.log(`[extension] registered ${name}`);
  console.log(`Saved to ${configPath()}`);
}

async function update(flags: Flags): Promise<void> {
  const name = requiredName(flags);
  const all = readRegistrations();
  const index = all.findIndex((entry) => entry.name === name);
  if (index === -1) die(`No extension named ${name} is registered.`);
  if (![...flags.keys()].some((flag) => SETTING_FLAGS.includes(flag))) {
    die("Nothing to update. Pass at least one setting, such as --command=...");
  }
  const registration = applySettings(all[index]!, flags);
  const next = all.map((entry, at) => (at === index ? registration : entry));
  await checkRunAfter(registration, next, flags.has("yes"));
  await writeRegistrations(next);
  console.log(`[extension] updated ${name}`);
}

async function setDisabled(flags: Flags, disabled: boolean): Promise<void> {
  const name = requiredName(flags);
  const all = readRegistrations();
  const index = all.findIndex((entry) => entry.name === name);
  if (index === -1) die(`No extension named ${name} is registered.`);
  const next = all.map((entry, at) => {
    if (at !== index) return entry;
    const { disabled: _old, ...rest } = entry;
    return disabled ? { ...rest, disabled: true } : rest;
  });
  await writeRegistrations(next);
  console.log(`[extension] ${disabled ? "disabled" : "enabled"} ${name}`);
}

async function removeOne(flags: Flags): Promise<void> {
  const name = requiredName(flags);
  const all = readRegistrations();
  if (!all.some((entry) => entry.name === name)) {
    die(`No extension named ${name} is registered.`);
  }
  await writeRegistrations(all.filter((entry) => entry.name !== name));
  console.log(`[extension] removed ${name}`);
  const waiting = all.filter((entry) => entry.runAfter === name);
  for (const entry of waiting) {
    console.log(
      `${entry.name} runs after ${name}, so it is skipped until that changes.`,
    );
  }
}

function describe(entry: ExtensionRegistration): string[] {
  const after = dependencyOf(entry);
  return [
    `${entry.name}${entry.disabled ? " (disabled)" : ""}`,
    `  command: ${entry.command}`,
    `  repos: ${entry.repos ?? "*"} · review types: ${entry.reviewTypes?.join(",") ?? "all"}`,
    `  runs: ${after ? `after ${after}` : "with the review"} · priority ${entry.priority ?? 0}${entry.failFast ? " · fail fast" : ""}`,
    `  timeout ${formatTimeout(entry.timeoutSeconds)} · retries on a bad response ${entry.retryOnFailTimes} · requested retries honoured ${entry.maxRequestedRetries} · rerun on restart ${rerunsOnRestart(entry) ? "yes" : "no"}`,
  ];
}

function list(flags: Flags): void {
  const all = readRegistrations();
  if (flags.has("json")) {
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        ok: true,
        disabledByEnvironment: extensionsDisabled(),
        extensions: all,
      }),
    );
    return;
  }
  if (extensionsDisabled()) console.log(DISABLED_MESSAGE);
  if (all.length === 0) {
    console.log("No extensions registered.");
    return;
  }
  console.log(all.flatMap(describe).join("\n"));
}

/** Runs one extension against the built-in mock review. No AI, no network,
 * nothing posted. The command runs exactly as a review would run it, so an
 * extension that starts before the review sees an empty review-results path
 * here too. */
async function debugRun(flags: Flags): Promise<void> {
  if (extensionsDisabled()) {
    throw new CliError("extensions_disabled", DISABLED_MESSAGE);
  }
  const name = requiredName(flags);
  const registered = readRegistrations().find((entry) => entry.name === name);
  const command = stringFlag(flags, "command");
  if (!registered && command === undefined) {
    die(
      `No extension named ${name} is registered. Register it, or pass --command=... to try a command first.`,
    );
  }
  const registration = applySettings(
    registered ?? { name, command: "", ...DEFAULTS },
    command === undefined ? new Map() : new Map([["command", command]]),
  );
  const waitsForReview = dependencyOf(registration) !== undefined;
  const folder = await openRunFolder({
    runId: `debug-${crypto.randomUUID()}`,
    owner: "cli",
    details: MOCK_DETAILS,
    diff: MOCK_DIFF,
  });
  try {
    if (waitsForReview) await writeReviewResult(folder, MOCK_REVIEW_RESULT);
    console.log(
      `debug-run · ${name} · ${MOCK_DETAILS.repo} PR ${MOCK_DETAILS.prNumber} (built-in mock)`,
    );
    console.log(
      waitsForReview
        ? "Review results: given, this extension starts after the review."
        : "Review results: empty, this extension starts with the review.",
    );
    const result = await runAttempts({
      registration,
      command: substitute(registration.command, {
        details_path: folder.detailsPath,
        review_result_path: waitsForReview ? folder.reviewResultPath : "",
        diff_path: folder.diffPath,
      }),
      log: (message) => console.error(`[extension] ${message}`),
    });
    const report = buildReport([result]);
    console.log("");
    console.log(cliExtensionLines(report).join("\n"));
    console.log("");
    console.log(cliExtensionFooter(report));
    if (result.usage?.costUsd !== undefined) {
      console.log(`Cost: $${result.usage.costUsd.toFixed(4)}`);
    }
    if (result.status === "failed" && result.details) {
      console.log("");
      console.log("Details:");
      console.log(stripControlChars(result.details));
    }
    exitWith(result.status === "failed" ? EXIT_RUNTIME : 0);
  } finally {
    await removeRunFolder(folder);
  }
}

export async function runExtensionCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(renderCommandHelp("extension"));
    return;
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
    die(
      `Unknown extension subcommand: ${sub}. Use one of: ${SUBCOMMANDS.join(", ")}`,
    );
  }
  const flags = parseFlags(sub, rest);
  if (sub === "register") await register(flags);
  else if (sub === "update") await update(flags);
  else if (sub === "list") list(flags);
  else if (sub === "remove") await removeOne(flags);
  else if (sub === "disable") await setDisabled(flags, true);
  else if (sub === "enable") await setDisabled(flags, false);
  else await debugRun(flags);
}
