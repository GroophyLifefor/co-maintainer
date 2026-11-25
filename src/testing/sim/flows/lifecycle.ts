/** `clear`, `rollback` and `uninstall` from the CLI.
 *
 * Guides of two repositories are on disk. One is cleared, then everything with the cache,
 * rollback is asked for with no backup, and uninstall runs without and with
 * `--yes`. Before uninstall runs, the flow refuses to go on unless every path
 * it would delete is inside this flow's sandbox. The checks read exit codes,
 * what the CLI printed and which files exist, never a model's answer. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  check,
  type CheckResult,
  type CliRun,
  defineFlow,
  type Sim,
} from "../flow.ts";

const REPO = "sim/lifecycle";
const OTHER = "sim/lifecycle-two";

const STEP = {
  guides: "two repositories with guides",
  clearOne: "clear one repository",
  clearAll: "clear all with the cache",
  rollback: "rollback with no backup",
  uninstallAsk: "uninstall with no terminal and no --yes",
  uninstall: "uninstall --yes",
  uninstallAgain: "uninstall --yes again",
};

const runAt = (sim: Sim, key: string) => sim.state[key] as CliRun;
const said = (run: CliRun) => `${run.stdout}\n${run.stderr}`;
const guidesOf = (sim: Sim, repo: string) => join(sim.paths.reposDir, repo);

/** Guides on disk the way `init` leaves them, written directly: the flow
 * tests what clears and uninstalls them, and an AI call would leave cost
 * rows in the database uninstall deletes. */
function guides(sim: Sim, repo: string): void {
  const dir = guidesOf(sim, repo);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "review-guide.md"),
    "# Review guide\n\n- Guard divisors.\n",
  );
}

/** Every path uninstall deletes, so the flow can refuse to run it outside
 * the sandbox. */
async function uninstallPaths(): Promise<string[]> {
  const config = await import("../../../config.ts");
  const { appDbPath } = await import("../../../store/app_db.ts");
  return [
    config.configPath(),
    config.cacheDbPath(),
    appDbPath(),
    config.reposDir(),
  ];
}

function checks(sim: Sim): CheckResult[] {
  const clearOne = runAt(sim, "clearOne");
  const clearAll = runAt(sim, "clearAll");
  const rollback = runAt(sim, "rollback");
  const ask = runAt(sim, "uninstallAsk");
  const uninstall = runAt(sim, "uninstall");
  const again = runAt(sim, "uninstallAgain");
  return [
    check(
      "clear owner/repo removes that repository's guides and keeps the other's",
      clearOne.exitCode === 0 &&
        sim.state.oneGoneAfterClear === true &&
        sim.state.otherKeptAfterClear === true,
      `exit ${clearOne.exitCode} · ${REPO} ${sim.state.oneGoneAfterClear ? "gone" : "kept"} · ${OTHER} ${sim.state.otherKeptAfterClear ? "kept" : "gone"}`,
    ),
    check(
      "clear all --include-cache removes every repository's guides",
      clearAll.exitCode === 0 && sim.state.allGoneAfterClear === true,
      `exit ${clearAll.exitCode} · ${sim.state.allGoneAfterClear ? "all gone" : "some kept"}`,
    ),
    check(
      "rollback with no backup stops with exit 2 and says there is no backup",
      rollback.exitCode === 2 && /no backup/i.test(said(rollback)),
      `exit ${rollback.exitCode} · ${said(rollback).trim().split("\n")[0]?.slice(0, 100)}`,
    ),
    check(
      "uninstall with no terminal and no --yes asks for --yes and deletes nothing",
      ask.exitCode === 2 &&
        /--yes/.test(said(ask)) &&
        sim.state.configKeptAfterAsk === true,
      `exit ${ask.exitCode} · config ${sim.state.configKeptAfterAsk ? "kept" : "gone"}`,
    ),
    check(
      "uninstall --yes deletes the data files and prints the npm command that finishes it",
      uninstall.exitCode === 0 &&
        sim.state.configGoneAfterUninstall === true &&
        /npm uninstall -g co-maintainer/.test(said(uninstall)),
      `exit ${uninstall.exitCode} · config ${sim.state.configGoneAfterUninstall ? "gone" : "kept"}`,
    ),
    check(
      "a second uninstall --yes finds nothing to remove",
      again.exitCode === 0 && /Nothing to remove/.test(said(again)),
      `exit ${again.exitCode} · ${said(again).trim().split("\n")[0]?.slice(0, 80)}`,
    ),
  ];
}

export default defineFlow({
  name: "lifecycle",
  description:
    "clear one repository and all with the cache, rollback with no backup, and uninstall with and without --yes, inside the sandbox only",
  steps: [
    {
      name: STEP.guides,
      async run(sim) {
        guides(sim, REPO);
        guides(sim, OTHER);
        return `${REPO} and ${OTHER} · guides ${existsSync(guidesOf(sim, REPO)) && existsSync(guidesOf(sim, OTHER))}`;
      },
    },
    {
      name: STEP.clearOne,
      async run(sim) {
        sim.state.clearOne = await sim.cli(["clear", REPO, "--yes"]);
        sim.state.oneGoneAfterClear = !existsSync(guidesOf(sim, REPO));
        sim.state.otherKeptAfterClear = existsSync(guidesOf(sim, OTHER));
        return `exit ${runAt(sim, "clearOne").exitCode}`;
      },
    },
    {
      name: STEP.clearAll,
      async run(sim) {
        guides(sim, REPO);
        sim.state.clearAll = await sim.cli([
          "clear",
          "all",
          "--include-cache",
          "--yes",
        ]);
        sim.state.allGoneAfterClear =
          !existsSync(guidesOf(sim, REPO)) && !existsSync(guidesOf(sim, OTHER));
        return `exit ${runAt(sim, "clearAll").exitCode}`;
      },
    },
    {
      name: STEP.rollback,
      async run(sim) {
        sim.state.rollback = await sim.cli(["rollback", "--yes"]);
        return `exit ${runAt(sim, "rollback").exitCode}`;
      },
    },
    {
      name: STEP.uninstallAsk,
      async run(sim) {
        sim.world.writeConfig({ lowModel: sim.options().lowModel });
        sim.state.uninstallAsk = await sim.cli(["uninstall"]);
        sim.state.configKeptAfterAsk = existsSync(
          (await import("../../../config.ts")).configPath(),
        );
        return `exit ${runAt(sim, "uninstallAsk").exitCode}`;
      },
    },
    {
      name: STEP.uninstall,
      async run(sim) {
        const root = resolve(sim.world.root);
        const outside = (await uninstallPaths()).filter((path) => {
          const rel = relative(root, resolve(path));
          return rel.startsWith("..") || isAbsolute(rel);
        });
        if (outside.length > 0) {
          throw new Error(
            `refusing to run uninstall, paths outside the sandbox: ${outside.join(", ")}`,
          );
        }
        const configPath = (await import("../../../config.ts")).configPath();
        sim.state.uninstall = await sim.cli(["uninstall", "--yes"]);
        sim.state.configGoneAfterUninstall = !existsSync(configPath);
        return `exit ${runAt(sim, "uninstall").exitCode}`;
      },
    },
    {
      name: STEP.uninstallAgain,
      async run(sim) {
        sim.state.uninstallAgain = await sim.cli(["uninstall", "--yes"]);
        return `exit ${runAt(sim, "uninstallAgain").exitCode}`;
      },
    },
  ],
  checks,
});
