/** `co-maintainer login-link` and the dashboard's sign-in link pages
 * (issue 160).
 *
 * `serve` is started with a public webhook address. The CLI makes a link,
 * the dashboard is asked for it the way a browser would: a GET that only
 * shows the confirm page, then the POST of the button. The flow reads the
 * HTTP status, headers and cookie, the `login_links` row and the audit log.
 * No AI is called, so the flow is the same with a real model. */
import { check, type CheckResult, defineFlow, type Sim } from "../flow.ts";
import { appRows } from "./app.ts";

const ORIGIN = "https://review.sim.test";

const STEP = {
  served: "serve with a public webhook address",
  made: "login-link prints a link",
  opened: "the link is opened",
  spent: "the button is pressed",
  replayed: "the same link is pressed again",
  replaced: "a second link replaces the first",
  otherHost: "a link pressed on another address",
};

type Seen = {
  status: number;
  cookie: string | null;
  referrer: string | null;
  cache: string | null;
};

let ipCounter = 0;

async function app() {
  const { createApp } = await import("../../../server/app.ts");
  return createApp({ password: "sim-password" });
}

async function press(token: string, host = "review.sim.test"): Promise<Seen> {
  const response = await (
    await app()
  ).fetch(
    new Request(`https://${host}/login/link`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${token}`,
    }),
    `10.9.0.${++ipCounter}`,
  );
  return {
    status: response.status,
    cookie: response.headers.get("set-cookie"),
    referrer: response.headers.get("referrer-policy"),
    cache: response.headers.get("cache-control"),
  };
}

async function makeLink(sim: Sim): Promise<string> {
  const run = await sim.cli(["login-link"]);
  const url = run.stdout.trim();
  if (!url.startsWith(`${ORIGIN}/login/link#`)) {
    throw new Error(
      `login-link printed ${url || "nothing"} (${run.stderr.trim()})`,
    );
  }
  return url.split("#")[1]!;
}

const seenAt = (sim: Sim, key: string) => sim.state[key] as Seen;

function checks(sim: Sim): CheckResult[] {
  const opened = seenAt(sim, "opened");
  const spent = seenAt(sim, "spent");
  const replayed = seenAt(sim, "replayed");
  const replacedOld = seenAt(sim, "replacedOld");
  const replacedNew = seenAt(sim, "replacedNew");
  const otherHost = seenAt(sim, "otherHost");
  const tokens = (sim.state.tokens as string[]) ?? [];
  const links = appRows<{ host: string; used_at: string | null }>(
    sim,
    `SELECT host, used_at FROM login_links`,
  );
  const audit = appRows<{ actor: string; summary: string }>(
    sim,
    `SELECT actor, summary FROM audit_log WHERE kind = 'sign-in' ORDER BY id`,
  );
  const auditText = JSON.stringify(
    appRows(sim, `SELECT * FROM audit_log WHERE kind = 'sign-in'`),
  );
  return [
    check(
      "opening the link shows the confirm page: no cookie, no-referrer, no-store, and the link is not spent",
      opened.status === 200 &&
        opened.cookie === null &&
        opened.referrer === "no-referrer" &&
        opened.cache === "no-store" &&
        sim.state.unspentAfterOpen === true,
      `${opened.status} · cookie ${opened.cookie ? "set" : "none"} · ${opened.referrer} · ${opened.cache}`,
    ),
    check(
      "pressing the button signs in once: 303 with an HttpOnly session cookie",
      spent.status === 303 &&
        /HttpOnly/i.test(spent.cookie ?? "") &&
        spent.referrer === "no-referrer",
      `${spent.status} · cookie ${spent.cookie ? "set" : "none"}`,
    ),
    check(
      "the same link a second time is refused with no cookie",
      replayed.status === 401 && replayed.cookie === null,
      `${replayed.status}`,
    ),
    check(
      "a second link replaces the first: the old one is refused, the new one works, one row is kept",
      replacedOld.status === 401 && replacedNew.status === 303,
      `old ${replacedOld.status} · new ${replacedNew.status}`,
    ),
    check(
      "a link pressed on another address is refused",
      otherHost.status === 401,
      `${otherHost.status} · rows ${links.map((row) => row.host).join(", ")}`,
    ),
    check(
      "the audit log has every link made and every sign-in, and never a token",
      audit.filter(
        (row) => row.summary === "Made a sign-in link" && row.actor === "cli",
      ).length === 4 &&
        audit.filter((row) => row.summary === "Signed in with a sign-in link")
          .length === 2 &&
        tokens.length === 4 &&
        tokens.every((token) => !auditText.includes(token)),
      `${audit.map((row) => row.summary).join(" | ")}`,
    ),
  ];
}

export default defineFlow({
  name: "login-link",
  description:
    "a one-time dashboard sign-in link made on the server: confirm page, one sign-in, replay, replacement and another address refused",
  steps: [
    {
      name: STEP.served,
      async run(sim) {
        await sim.server.start({ webhookUrl: `${ORIGIN}/github/webhook` });
        return `serve at ${ORIGIN}`;
      },
    },
    {
      name: STEP.made,
      async run(sim) {
        const token = await makeLink(sim);
        sim.state.tokens = [token];
        return "one link";
      },
    },
    {
      name: STEP.opened,
      async run(sim) {
        const response = await (
          await app()
        ).fetch(new Request(`${ORIGIN}/login/link`), `10.9.0.${++ipCounter}`);
        sim.state.opened = {
          status: response.status,
          cookie: response.headers.get("set-cookie"),
          referrer: response.headers.get("referrer-policy"),
          cache: response.headers.get("cache-control"),
        } satisfies Seen;
        sim.state.unspentAfterOpen =
          appRows<{ used_at: string | null }>(
            sim,
            `SELECT used_at FROM login_links`,
          )[0]?.used_at === null;
        return `${response.status}`;
      },
    },
    {
      name: STEP.spent,
      async run(sim) {
        const [token] = sim.state.tokens as string[];
        sim.state.spent = await press(token!);
        return `${seenAt(sim, "spent").status}`;
      },
    },
    {
      name: STEP.replayed,
      async run(sim) {
        const [token] = sim.state.tokens as string[];
        sim.state.replayed = await press(token!);
        return `${seenAt(sim, "replayed").status}`;
      },
    },
    {
      name: STEP.replaced,
      async run(sim) {
        const first = await makeLink(sim);
        const second = await makeLink(sim);
        (sim.state.tokens as string[]).push(first, second);
        sim.state.replacedOld = await press(first);
        sim.state.replacedNew = await press(second);
        return `old ${seenAt(sim, "replacedOld").status} · new ${seenAt(sim, "replacedNew").status}`;
      },
    },
    {
      name: STEP.otherHost,
      async run(sim) {
        const run = await sim.cli([
          "login-link",
          "--origin=https://other.sim.test",
        ]);
        const token = run.stdout.trim().split("#")[1] ?? "";
        (sim.state.tokens as string[]).push(token);
        sim.state.otherHost = await press(token, "review.sim.test");
        return `${seenAt(sim, "otherHost").status}`;
      },
    },
  ],
  checks,
});
