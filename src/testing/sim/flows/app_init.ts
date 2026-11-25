/** Init, sync and remake from the dashboard's queue on a server that has the
 * GitHub App and no `gh` login and no PAT.
 *
 * Before 0.7.29 these jobs used the saved login, so Add repository failed on
 * such a server. The config here says `auth: pat` with no token, the repository
 * belongs to the App's installation, and the jobs must still finish. The
 * checks read the jobs' status, the guides on disk and the saved state,
 * never a model's answer. */
import type { AiRule } from "../fake_ai.ts";
import { check, type CheckResult, defineFlow, type Sim } from "../flow.ts";
import { SAMPLE_REPO } from "../sample_repo.ts";
import { INIT_AI } from "./init.ts";

const REPO = "sim/app-init";

const STEP = {
  served: "serve with the App and no login",
  init: "init from the queue",
  remake: "remake from the queue",
  noApp: "the same repository when the App is not installed on it",
};

const AI: AiRule[] = INIT_AI;

type Finished = { type: string; status: string }[];

const finished = (sim: Sim, key: string) => sim.state[key] as Finished;
const done = (jobs: Finished, type: string) =>
  jobs.some((job) => job.type === type && job.status === "done");

export default defineFlow({
  name: "app-init",
  description:
    "init and remake queued in serve finish on a server with the App and no gh login or PAT, and a repository the App is not installed on still asks for the login",
  ai: AI,
  steps: [
    {
      name: STEP.served,
      async run(sim) {
        sim.repo(REPO, SAMPLE_REPO);
        // `auth: pat` and no token: the saved login cannot read anything.
        await sim.server.start({ auth: "pat", githubPat: undefined });
        const { activateRepo } = await import("../../../store/repos.ts");
        activateRepo(REPO, sim.world.github.installation.id);
        return `${REPO} on installation ${sim.world.github.installation.id}`;
      },
    },
    {
      name: STEP.init,
      async run(sim) {
        const { enqueueSetup } = await import("../../../services/setup.ts");
        enqueueSetup(REPO, "init");
        sim.state.init = await sim.server.runJobs();
        const { readState } = await import("../../../store/skill_state.ts");
        sim.state.stateAfterInit = (await readState(REPO)) !== undefined;
        return JSON.stringify(finished(sim, "init"));
      },
    },
    {
      name: STEP.remake,
      async run(sim) {
        const { enqueueSetup } = await import("../../../services/setup.ts");
        enqueueSetup(REPO, "remake");
        sim.state.remake = await sim.server.runJobs();
        return JSON.stringify(finished(sim, "remake"));
      },
    },
    {
      name: STEP.noApp,
      async run(sim) {
        // A repository on no installation, with no login either: the job
        // falls back to the saved login and says what is missing.
        const { enqueueSetup } = await import("../../../services/setup.ts");
        const { activateRepo } = await import("../../../store/repos.ts");
        const other = "sim/app-init-other";
        sim.repo(other, SAMPLE_REPO);
        activateRepo(other, undefined);
        sim.world.writeConfig({ githubAppId: undefined });
        enqueueSetup(other, "init");
        sim.state.other = await sim.server.runJobs();
        return JSON.stringify(finished(sim, "other"));
      },
    },
  ],
  checks(sim: Sim): CheckResult[] {
    const init = finished(sim, "init");
    const remake = finished(sim, "remake");
    const other = finished(sim, "other");
    return [
      check(
        "init finishes with the App alone, and the guides are built",
        done(init, "init") && sim.state.stateAfterInit === true,
        `${JSON.stringify(init)} · state ${sim.state.stateAfterInit}`,
      ),
      check(
        "remake finishes with the App alone",
        done(remake, "remake"),
        JSON.stringify(remake),
      ),
      check(
        "with no App and no token the job fails instead of reading as someone else",
        !done(other, "init"),
        JSON.stringify(other),
      ),
    ];
  },
});
