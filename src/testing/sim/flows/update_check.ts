/** The release check and "What's new": what a server tells its admin about a
 * newer version, and the one request it makes when the admin asks to update.
 *
 * The flow gives the product's own code a stand-in for the two addresses it
 * reads, GitHub's latest release and the changelog, so nothing leaves the
 * simulation. A server without an update address offers no update. A newer
 * stable release is offered, a pre-release is not, an older version is never
 * offered, and the update request goes to the host's address once, for the
 * latest release only. What's new lists the sections the server has not seen.
 *
 * Every check reads what the product kept and what it sent, never a model's
 * answer, so the flow passes with a real model too. */
import type { AiRule } from "../fake_ai.ts";
import { check, defineFlow, type CheckResult, type Sim } from "../flow.ts";
import { serveRepo } from "./app.ts";
import { INIT_AI } from "./init.ts";

const STEP = {
  served: "serve a repository",
  none: "a server with no update address",
  newer: "a newer stable release",
  pre: "a pre-release a day later",
  update: "the admin updates",
  refused: "an older and an unknown version",
  news: "What's new",
};

const AI: AiRule[] = [...INIT_AI];

const HOST = "http://update.sim.invalid/run";
const DAY = 24 * 60 * 60 * 1000;
const RELEASE = {
  tag_name: "v99.0.0",
  html_url: "https://github.test/releases/v99.0.0",
};
const CHANGELOG = `# Changelog

## [99.0.0] - 2030-01-01

### Added

- **A big thing.** It is new.

## [98.0.0] - 2029-12-01

### Fixed

- **A small thing.** It is fixed.

## [0.0.1] - 2020-01-01

### Added

- **The start.**
`;

type Sent = { url: string; method: string; body: string };

function fake(sent: Sent[], answer: (url: string) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
    });
    return answer(url);
  }) as typeof fetch;
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

function checks(sim: Sim): CheckResult[] {
  const s = sim.state as Record<string, any>;
  return [
    check(
      "a server with no update address offers no update",
      s.none.canUpdate === false && s.none.latest === undefined,
      JSON.stringify(s.none),
    ),
    check(
      "a newer stable release is offered with its notes link",
      s.newer.latest === "99.0.0" &&
        s.newer.notesUrl === RELEASE.html_url &&
        s.newerCalls === 1,
      `${String(s.newer.latest)} · ${s.newerCalls} release calls`,
    ),
    check(
      "a pre-release is not offered",
      s.pre.latest === undefined,
      String(s.pre.latest),
    ),
    check(
      "the update request is one POST to the host's address naming the version",
      s.updateSent.length === 1 &&
        s.updateSent[0].url === HOST &&
        s.updateSent[0].method === "POST" &&
        JSON.parse(s.updateSent[0].body).version === "99.0.0" &&
        s.updated.ok === true &&
        s.updated.state.status === "requested",
      `${s.updateSent.length} requests · ${String(s.updated.state?.status)}`,
    ),
    check(
      "an older version and one that is not the latest are refused with nothing sent",
      s.refusedSent.length === 0 &&
        s.refusedOld.ok === false &&
        /not newer/.test(s.refusedOld.problem) &&
        s.refusedOther.ok === false,
      `${s.refusedSent.length} requests`,
    ),
    check(
      "What's new lists the sections after the running version, newest first, up to the latest",
      s.news.newer === true &&
        s.news.sections.map((x: { version: string }) => x.version).join() ===
          "99.0.0,98.0.0",
      s.news.sections.map((x: { version: string }) => x.version).join(),
    ),
  ];
}

export default defineFlow({
  name: "update-check",
  description:
    "a newer stable release is offered, a pre-release and an older version are not, the update request is one POST for the latest release, What's new lists the unseen sections",
  ai: AI,
  steps: [
    {
      name: STEP.served,
      async run(sim) {
        await serveRepo(sim);
        delete process.env.CM_UPDATE_URL;
        return "served";
      },
    },
    {
      name: STEP.none,
      async run(sim) {
        const { updateNotice } =
          await import("../../../services/update_check.ts");
        sim.state.none = updateNotice();
        return JSON.stringify(sim.state.none);
      },
    },
    {
      name: STEP.newer,
      async run(sim) {
        process.env.CM_UPDATE_URL = HOST;
        const { refreshReleaseCheck, updateNotice } =
          await import("../../../services/update_check.ts");
        const sent: Sent[] = [];
        await refreshReleaseCheck({
          nowMs: Date.now(),
          fetcher: fake(sent, () => json(RELEASE)),
        });
        sim.state.newerCalls = sent.length;
        sim.state.newer = updateNotice();
        return `${sent.length} calls · ${String((sim.state.newer as { latest?: string }).latest)}`;
      },
    },
    {
      name: STEP.pre,
      async run(sim) {
        const { refreshReleaseCheck, updateNotice } =
          await import("../../../services/update_check.ts");
        await refreshReleaseCheck({
          nowMs: Date.now() + 2 * DAY,
          fetcher: fake([], () =>
            json({ ...RELEASE, tag_name: "v100.0.0-beta.1", prerelease: true }),
          ),
        });
        sim.state.pre = updateNotice();
        return String((sim.state.pre as { latest?: string }).latest);
      },
    },
    {
      name: STEP.update,
      async run(sim) {
        // The pre-release answer replaced the kept release. Ask again.
        const { refreshReleaseCheck, startUpdate } =
          await import("../../../services/update_check.ts");
        await refreshReleaseCheck({
          nowMs: Date.now() + 4 * DAY,
          fetcher: fake([], () => json(RELEASE)),
        });
        const sent: Sent[] = [];
        sim.state.updated = await startUpdate(
          "99.0.0",
          fake(sent, () => json({})),
        );
        sim.state.updateSent = sent;
        return `${sent.length} requests`;
      },
    },
    {
      name: STEP.refused,
      async run(sim) {
        const { startUpdate } =
          await import("../../../services/update_check.ts");
        const sent: Sent[] = [];
        sim.state.refusedOld = await startUpdate(
          "0.0.1",
          fake(sent, () => json({})),
        );
        sim.state.refusedOther = await startUpdate(
          "98.0.0",
          fake(sent, () => json({})),
        );
        sim.state.refusedSent = sent;
        return `${sent.length} requests`;
      },
    },
    {
      name: STEP.news,
      async run(sim) {
        const { checkWhatsNew } =
          await import("../../../services/whats_new.ts");
        const sent: Sent[] = [];
        sim.state.news = await checkWhatsNew({
          running: "0.0.1",
          fetcher: fake(sent, (url) =>
            url.includes("releases") ? json(RELEASE) : new Response(CHANGELOG),
          ),
        });
        delete process.env.CM_UPDATE_URL;
        return `${sent.length} calls`;
      },
    },
  ],
  checks,
});
