/** The diagram runtime: Mermaid, PlantUML, or a PlantUML server.
 *
 * Local review shows what the model is asked and what comes back for each
 * runtime, from a flag and from the repository setting `set --repo` writes.
 * An App review, started by a webhook, shows that the setting reaches the
 * background jobs, that a token the model quotes inside a diagram never
 * reaches the pull request, and that a bad stored value does not stop a
 * review. Every check reads the trace and what was posted, never what a
 * function returned.
 *
 * It builds on the local and App flows' exports and edits neither. */
import { DatabaseSync } from "node:sqlite";
import { inflateRawSync } from "node:zlib";
import type { AiRule } from "../fake_ai.ts";
import { finding } from "../fake_ai.ts";
import {
  check,
  type CheckResult,
  defineFlow,
  type Score,
  scriptedCheck,
  type Sim,
  type Step,
} from "../flow.ts";
import type { AiCall } from "../trace.ts";
import { SAMPLE_REPO } from "../sample_repo.ts";
import {
  APP_REPO as _APP_REPO,
  OPENED_MATH,
  openPull,
  serveRepo,
  writesIn,
} from "./app.ts";
import {
  type Chat,
  chatOf,
  checkoutStep,
  jsonFindings,
  LOCAL_BASE_AI,
  LOCAL_CHANGE,
  LOCAL_SMELLS,
  localState,
  modelFindings,
  NO_CODEGRAPH,
  prepareLocalRepo,
  reviewChat,
  reviewerReply,
  reviewStep,
  type ReviewRun,
  type Smell,
} from "./local.ts";

type Json = Record<string, unknown>;

const LOCAL_REPO_NAME = "sim/sample";
/** The repository the App serves. A second one, so the local review and the
 * App never share guides or settings. */
const DIAGRAM_APP_REPO = "sim/diagrams";
void _APP_REPO;

const SERVER = "https://uml.example.com";
/** Shaped like a GitHub token and not one of the world's own secrets. The
 * model quotes it inside a diagram. */
const DRAWN_TOKEN = `ghp_${"Qm7".repeat(12)}`;

const LOCAL_SOURCE = [
  "@startuml",
  "Caller -> average : an empty list",
  "average --> Caller : NaN",
  "@enduml",
].join("\n");
const APP_SOURCE = [
  "@startuml",
  "Caller -> divide : a / 0",
  `divide -> Logger : token ${DRAWN_TOKEN}`,
  "divide --> Caller : Infinity",
  "@enduml",
].join("\n");

const fence = (source: string) => `\`\`\`plantuml\n${source}\n\`\`\``;

// ------------------------------------------------------------ the fake model

/** The model draws when the request asks for PlantUML. With the default
 * runtime the request never says "PlantUML", so these rules do not answer
 * and the plain reviewer does. */
const DRAWN_SMELL: Smell = {
  ...LOCAL_SMELLS[0]!,
  finding: (line) => ({
    ...LOCAL_SMELLS[0]!.finding(line),
    body: `An empty list divides zero by zero.\n\n${fence(LOCAL_SOURCE)}`,
  }),
};

const DIAGRAM_AI: AiRule[] = [
  {
    name: "local review draws PlantUML",
    job: "review_local",
    prompt: "PlantUML",
    reply: (call) => reviewerReply([DRAWN_SMELL], call),
  },
  {
    name: "App review draws PlantUML with a token in it",
    job: "review_pull_request",
    prompt: "PlantUML",
    reply: {
      findings: [
        finding({
          path: "src/math.ts",
          line: 10,
          severity: "P1",
          blocking: true,
          title: "divide does not guard a zero divisor",
          body: `A zero divisor returns Infinity.\n\n${fence(APP_SOURCE)}`,
        }),
      ],
    },
  },
  {
    name: "App review with Mermaid",
    job: "review_pull_request",
    reply: {
      findings: [
        finding({
          path: "src/strings.ts",
          line: 1,
          title: "The constant is never read",
          body: "Nothing imports slug.",
        }),
      ],
    },
  },
  ...LOCAL_BASE_AI,
];

// ----------------------------------------------------------------- the steps

const LOCAL = {
  default: "local review, default runtime",
  plantuml: "local review, --diagram-runtime=plantuml",
  server: "local review, --diagram-runtime=plantuml-server",
  stored: "local review, runtime from set --repo",
  remote: "usage error, --remote with a diagram flag",
  badRuntime: "usage error, unknown runtime",
  badServer: "usage error, server that is not http",
  badFormat: "usage error, unknown format",
} as const;

const APP = {
  served: "App repository served",
  stored: "set --repo plantuml-server",
  server: "App review with plantuml-server",
  broken: "stored runtime edited by hand",
  fallback: "App review with a bad stored value",
} as const;

const FLAGS_SERVER = [
  "--diagram-runtime=plantuml-server",
  `--plantuml-server=${SERVER}`,
  "--plantuml-output-format=png",
];

const configRepo = (sim: Sim, repo: string): Json =>
  ((sim.world.readConfig().repos as Record<string, Json> | undefined) ?? {})[
    repo
  ] ?? {};

const STRINGS_FILE = "export const slug = 1;\n";

const steps: Step[] = [
  {
    name: "repository with guides",
    async run(sim) {
      await prepareLocalRepo(sim);
      return "sim/sample · guides built by init";
    },
  },
  checkoutStep("main", LOCAL_CHANGE),
  reviewStep(LOCAL.default, "main", ["--json", NO_CODEGRAPH]),
  reviewStep(LOCAL.plantuml, "main", [
    "--json",
    NO_CODEGRAPH,
    "--fresh",
    "--diagram-runtime=plantuml",
  ]),
  reviewStep(LOCAL.server, "main", [
    "--json",
    NO_CODEGRAPH,
    "--fresh",
    ...FLAGS_SERVER,
  ]),
  {
    name: "set --repo plantuml for the local repository",
    async run(sim) {
      const run = await sim.cli([
        "set",
        `--repo=${LOCAL_REPO_NAME}`,
        "--diagram-runtime=plantuml",
      ]);
      if (run.exitCode !== 0) throw new Error(run.stderr);
      return JSON.stringify(configRepo(sim, LOCAL_REPO_NAME));
    },
  },
  reviewStep(LOCAL.stored, "main", ["--json", NO_CODEGRAPH, "--fresh"]),
  reviewStep(LOCAL.remote, "main", [
    "--json",
    "--remote",
    "--diagram-runtime=plantuml",
  ]),
  reviewStep(LOCAL.badRuntime, "main", [
    "--json",
    NO_CODEGRAPH,
    "--diagram-runtime=graphviz",
  ]),
  reviewStep(LOCAL.badServer, "main", [
    "--json",
    NO_CODEGRAPH,
    "--plantuml-server=ftp://uml.example.com",
  ]),
  reviewStep(LOCAL.badFormat, "main", [
    "--json",
    NO_CODEGRAPH,
    "--plantuml-output-format=gif",
  ]),
  {
    name: APP.served,
    async run(sim) {
      await serveRepo(sim, DIAGRAM_APP_REPO, SAMPLE_REPO);
      return `${DIAGRAM_APP_REPO} · guides built · auto review on`;
    },
  },
  {
    name: APP.stored,
    async run(sim) {
      const run = await sim.cli([
        "set",
        `--repo=${DIAGRAM_APP_REPO}`,
        "--diagram-runtime=plantuml-server",
        `--plantuml-server=${SERVER}`,
      ]);
      if (run.exitCode !== 0) throw new Error(run.stderr);
      sim.state.stored = configRepo(sim, DIAGRAM_APP_REPO);
      return JSON.stringify(sim.state.stored);
    },
  },
  {
    name: APP.server,
    async run(sim) {
      const round = await openPull(
        sim,
        {
          title: "Add divide and average",
          files: { "src/math.ts": OPENED_MATH },
        },
        DIAGRAM_APP_REPO,
      );
      return `#${round.pull.number} · ${round.jobs.map((job) => `${job.type} ${job.status}`).join(", ")}`;
    },
  },
  {
    name: APP.broken,
    run(sim) {
      // A hand edit, or a downgrade after a later version adds a runtime.
      const repos = {
        ...(sim.world.readConfig().repos as Record<string, Json>),
      };
      repos[DIAGRAM_APP_REPO] = {
        ...repos[DIAGRAM_APP_REPO],
        diagramRuntime: "d2",
      };
      sim.world.writeConfig({ repos });
      return `diagramRuntime is ${String(configRepo(sim, DIAGRAM_APP_REPO).diagramRuntime)}`;
    },
  },
  {
    name: APP.fallback,
    async run(sim) {
      const round = await openPull(
        sim,
        { title: "Add slug", files: { "src/strings.ts": STRINGS_FILE } },
        DIAGRAM_APP_REPO,
      );
      return `#${round.pull.number} · ${round.jobs.map((job) => `${job.type} ${job.status}`).join(", ")}`;
    },
  },
];

// ------------------------------------------------------------------- readers

const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

/** The source a PlantUML link carries. Written here, so the product's own
 * encoder cannot agree with itself. */
function decodeLink(url: string): string {
  const code = url.split("/").at(-1) ?? "";
  const bytes: number[] = [];
  for (let at = 0; at < code.length; at += 4) {
    const v = [0, 1, 2, 3].map((k) => ALPHABET.indexOf(code[at + k]!));
    bytes.push(
      (v[0]! << 2) | (v[1]! >> 4),
      ((v[1]! & 15) << 4) | (v[2]! >> 2),
      ((v[2]! & 3) << 6) | v[3]!,
    );
  }
  return inflateRawSync(Buffer.from(bytes)).toString("utf8");
}

const IMAGE_LINK = /!\[PlantUML diagram\]\((https?:\/\/[^)\s]+)\)/g;

const linksIn = (text: string): string[] =>
  [...text.matchAll(IMAGE_LINK)].map((match) => match[1]!);

function runOf(sim: Sim, label: string): ReviewRun {
  const run = localState(sim).runs.get(label);
  if (!run) throw new Error(`no review run named "${label}"`);
  return run;
}

const bodiesOf = (run: ReviewRun): string[] =>
  jsonFindings(run).map((item) => String(item.body));

/** The review request's wording: system and user prompt. */
const wording = (chat: Chat): string => `${chat.system}\n${chat.user}`;

function appRequest(sim: Sim, step: string): Chat | undefined {
  const call = sim.trace.ai.find(
    (item) => item.step === step && item.job === "review_pull_request",
  );
  return call ? chatOf(call) : undefined;
}

function reviewPosts(sim: Sim, step: string) {
  return writesIn(sim, step).filter(
    (write) =>
      write.method === "POST" && /\/pulls\/\d+\/reviews$/.test(write.path),
  );
}

/** Everything one step posted, as one string. */
const postedIn = (sim: Sim, step: string): string =>
  JSON.stringify(writesIn(sim, step).map((write) => write.body));

function jobLogs(sim: Sim): string[] {
  const database = new DatabaseSync(sim.paths.appDb, { readOnly: true });
  try {
    return (
      database.prepare("SELECT message FROM job_logs").all() as {
        message: string;
      }[]
    ).map((row) => row.message);
  } finally {
    database.close();
  }
}

const result = (name: string, problems: string[], good: string): CheckResult =>
  check(name, problems.length === 0, problems.join(" · ") || good);

/** What a live run skips: it holds for the diagrams the fake model draws. */
const scriptedResult = (
  sim: Sim,
  name: string,
  problems: string[],
  good: string,
  why = "the diagrams are the model's",
): CheckResult =>
  scriptedCheck(
    sim,
    name,
    problems.length === 0,
    problems.join(" · ") || good,
    why,
  );

/** The fenced PlantUML blocks a model answer holds. */
const plantumlBlocks = (text: string): string[] =>
  [...text.matchAll(/```plantuml\n([\s\S]*?)\n```/g)].map((m) => m[1]!);

const MERMAID_MARKERS = [
  "Mermaid selection and minimal syntax:",
  "flowchart = decisions, branches, pipelines, and fallback paths;",
  "If a diagram is useful, call read-mermaid-syntaxes before writing any Mermaid.",
];

// -------------------------------------------------------------------- checks

function localChecks(sim: Sim): CheckResult[] {
  const out: CheckResult[] = [];

  const base = runOf(sim, LOCAL.default);
  const baseChat = reviewChat(base)[0];
  const problems: string[] = [];
  if (!baseChat) problems.push("no review request");
  else {
    for (const marker of MERMAID_MARKERS) {
      if (!baseChat.system.includes(marker)) {
        problems.push(`the system prompt lost "${marker}"`);
      }
    }
    if (!baseChat.user.includes("include a Mermaid fenced code block")) {
      problems.push("the review prompt lost its Mermaid sentence");
    }
    if (JSON.stringify(baseChat.tools) !== '["read-mermaid-syntaxes"]') {
      problems.push(`tools ${JSON.stringify(baseChat.tools)}`);
    }
    if (/PlantUML|plantuml/.test(wording(baseChat))) {
      problems.push("PlantUML wording in a default review");
    }
  }
  out.push(
    result(
      "the default runtime asks for Mermaid exactly as before",
      problems,
      "Mermaid wording in system and review prompt, only the Mermaid syntax tool, no PlantUML word",
    ),
    scriptedResult(
      sim,
      "a default review holds no PlantUML block",
      bodiesOf(base).some((body) => body.includes("plantuml"))
        ? ["a PlantUML block in a default review"]
        : [],
      "no PlantUML block in the output",
      "what the model writes is its answer",
    ),
  );

  const plantuml = runOf(sim, LOCAL.plantuml);
  const chat = reviewChat(plantuml)[0];
  const asked: string[] = [];
  if (!chat) asked.push("no review request");
  else {
    if (!chat.system.includes("PlantUML selection and minimal syntax:")) {
      asked.push("no PlantUML guidance in the system prompt");
    }
    if (!chat.user.includes("@startuml and @enduml")) {
      asked.push("the review prompt does not ask for @startuml source");
    }
    if (/Mermaid|mermaid/.test(wording(chat))) {
      asked.push("Mermaid wording left in the request");
    }
    if (chat.tools.length !== 0) {
      asked.push(`tools ${JSON.stringify(chat.tools)}`);
    }
  }
  const bodies = bodiesOf(plantuml);
  const keptFence: string[] = [];
  if (!bodies.some((body) => body.includes(fence(LOCAL_SOURCE)))) {
    keptFence.push("the fenced source is not in the output");
  }
  // Whatever PlantUML the model wrote stays in the output as it wrote it.
  const drawn = modelFindings(plantuml).flatMap((item) =>
    plantumlBlocks(String(item.body)),
  );
  const lost = drawn.filter(
    (source) => !bodies.some((body) => body.includes(fence(source))),
  );
  const image = bodies.some((body) => body.includes("![PlantUML diagram]"))
    ? ["plantuml turned the source into an image"]
    : [];
  out.push(
    scriptedResult(
      sim,
      "plantuml asks for PlantUML, offers no Mermaid tool and keeps the fenced source",
      [...asked, ...keptFence, ...image],
      "PlantUML wording, no tools, the model's fence is in the output unchanged",
    ),
    result(
      "plantuml asks for PlantUML, offers no Mermaid tool and keeps every fence the model wrote",
      [
        ...asked,
        ...image,
        ...lost.map(() => "a fence the model wrote is not in the output"),
      ],
      "PlantUML wording, no tools, each of the model's fences is in the output unchanged",
    ),
  );

  const server = runOf(sim, LOCAL.server);
  const serverChat = reviewChat(server)[0];
  const linked: string[] = [];
  const serverBodies = bodiesOf(server);
  const links = serverBodies.flatMap(linksIn);
  // What holds for whatever the model drew: each link is on the chosen
  // server and format, and decodes to a diagram the model wrote.
  const modelSources = modelFindings(server).flatMap((item) =>
    plantumlBlocks(String(item.body)),
  );
  for (const link of links) {
    if (!link.startsWith(`${SERVER}/png/`)) linked.push(`link ${link}`);
    else if (
      !modelSources.some((source) => source.trim() === decodeLink(link).trim())
    ) {
      linked.push("a link does not decode to a diagram the model wrote");
    }
  }
  if (serverChat && chat && serverChat.system !== chat.system) {
    linked.push("plantuml-server asked for something other than plantuml");
  }
  // The model must have written source: it is the product that makes links.
  if (
    modelFindings(server).some((item) =>
      String(item.body).includes("![PlantUML"),
    )
  ) {
    linked.push("the model was shown or wrote a link");
  }
  const oneLink: string[] = [];
  if (links.length !== 1) oneLink.push(`${links.length} links in the output`);
  else if (decodeLink(links[0]!).trim() !== LOCAL_SOURCE) {
    oneLink.push("the link does not decode to the model's source");
  }
  if (serverBodies.some((body) => body.includes("```plantuml"))) {
    oneLink.push("a fence is left next to the link");
  }
  out.push(
    scriptedResult(
      sim,
      "plantuml-server turns the diagram into one image link on the chosen server and format",
      [...linked, ...oneLink],
      `one ${SERVER}/png link that decodes to the model's source, no fence`,
    ),
    result(
      "plantuml-server puts each link on the chosen server and format, and it decodes to the model's diagram",
      linked,
      `${links.length} ${SERVER}/png links, each decoding to a diagram the model wrote`,
    ),
  );

  const stored = runOf(sim, LOCAL.stored);
  const storedChat = reviewChat(stored)[0];
  const fromSetting: string[] = [];
  if (!storedChat || !chat || storedChat.system !== chat.system) {
    fromSetting.push("the request differs from --diagram-runtime=plantuml");
  }
  const repo = configRepo(sim, LOCAL_REPO_NAME);
  if (repo.diagramRuntime !== "plantuml") {
    fromSetting.push(`config holds ${JSON.stringify(repo)}`);
  }
  out.push(
    result(
      "set --repo stores the runtime and a review without the flag uses it",
      fromSetting,
      "config.json has diagramRuntime plantuml, the request is the same as with the flag",
    ),
    scriptedResult(
      sim,
      "a review that uses the stored runtime keeps the model's fenced source",
      bodiesOf(stored).some((body) => body.includes(fence(LOCAL_SOURCE)))
        ? []
        : ["the fenced source is not in the output"],
      "the fence is in the output",
    ),
  );

  const refusals: [string, RegExp][] = [
    [LOCAL.remote, /--diagram-runtime cannot be used with --remote/],
    [LOCAL.badRuntime, /--diagram-runtime must be one of: mermaid, plantuml/],
    [LOCAL.badServer, /--plantuml-server must be an http or https URL/],
    [LOCAL.badFormat, /--plantuml-output-format must be one of: svg, png/],
  ];
  const usage: string[] = [];
  for (const [label, message] of refusals) {
    const run = runOf(sim, label);
    const text = `${run.cli.stdout}${run.cli.stderr}`;
    if (run.cli.exitCode !== 2)
      usage.push(`${label}: exit ${run.cli.exitCode}`);
    if (!message.test(text)) usage.push(`${label}: message "${text.trim()}"`);
    if (run.ai.length > 0) usage.push(`${label}: called the model`);
    if (run.githubWrites > 0) usage.push(`${label}: wrote to GitHub`);
  }
  out.push(
    result(
      "a bad diagram flag, or one with --remote, is a usage error before any call",
      usage,
      "4 refusals, exit 2, the message names the flag, no model call, no write",
    ),
  );
  return out;
}

function appChecks(sim: Sim): CheckResult[] {
  const out: CheckResult[] = [];

  const stored = sim.state.stored as Json | undefined;
  const served = appRequest(sim, APP.server);
  const posts = reviewPosts(sim, APP.server);
  const posted = postedIn(sim, APP.server);
  // The finding is posted in the review's inline comment and again in the
  // check run's output, so the same link may appear in more than one write.
  const links = [
    ...new Set(
      writesIn(sim, APP.server).flatMap((write) =>
        linksIn(JSON.stringify(write.body).replaceAll("\\n", "\n")),
      ),
    ),
  ];
  const problems: string[] = [];
  const drawn: string[] = [];
  if (
    stored?.diagramRuntime !== "plantuml-server" ||
    stored.plantumlServer !== SERVER
  ) {
    problems.push(`set --repo stored ${JSON.stringify(stored)}`);
  }
  if (posts.length !== 1) problems.push(`${posts.length} reviews posted`);
  for (const link of links) {
    if (!link.startsWith(`${SERVER}/svg/`)) problems.push(`link ${link}`);
    const source = decodeLink(link);
    if (source.includes(DRAWN_TOKEN) || source.includes("ghp_")) {
      problems.push("the link carries the token");
    }
  }
  if (links.length !== 1)
    drawn.push(`${links.length} different image links posted`);
  else {
    const source = decodeLink(links[0]!);
    if (!source.includes("[redacted]")) {
      drawn.push("the link source does not show the redaction");
    }
    if (!source.includes("Caller -> divide : a / 0")) {
      drawn.push("the rest of the diagram is gone");
    }
  }
  if (posted.includes("```plantuml") || posted.includes("```\\nplantuml")) {
    drawn.push("a fence was posted");
  }
  if (posted.includes(DRAWN_TOKEN) || /ghp_[A-Za-z0-9]{20,}/.test(posted)) {
    problems.push("the token was posted");
  }
  const answer = sim.trace.ai.find(
    (item) => item.step === APP.server && item.job === "review_pull_request",
  );
  if (!JSON.stringify(answer?.response ?? "").includes(DRAWN_TOKEN)) {
    drawn.push("the model never quoted the token, so this proves nothing");
  }
  if (!served) problems.push("no review request");
  else {
    if (!served.system.includes("PlantUML selection and minimal syntax:")) {
      problems.push("the App request has no PlantUML wording");
    }
    if (/Mermaid|mermaid/.test(wording(served))) {
      problems.push("Mermaid wording in the App request");
    }
    if (served.tools.length !== 0) {
      problems.push(`tools ${JSON.stringify(served.tools)}`);
    }
  }
  out.push(
    scriptedResult(
      sim,
      "an App review with plantuml-server posts an image link, no fence and no secret",
      [...problems, ...drawn],
      "one review, one svg link on the chosen server, the token cut before it was encoded, PlantUML wording, no tools",
      "the diagram, and the token it quotes, are the model's",
    ),
    result(
      "an App review with plantuml-server posts one review, its links on the chosen server, and no token",
      problems,
      "one review, every link on the chosen server, no token in a link or a post, PlantUML wording, no tools",
    ),
  );

  const hosts = [
    ...sim.trace.github.map((call) => call.url),
    ...sim.trace.ai.map((call) => call.url),
    ...sim.trace.remote.map((call) => call.url),
    // A request to a host the simulation does not know is recorded here.
    ...sim.trace.leaks.map((leak) => leak.url),
  ];
  const reached = hosts.filter((url) => url.includes("uml.example.com"));
  out.push(
    check(
      "the product builds the PlantUML link and never fetches it",
      reached.length === 0,
      reached.length
        ? `${reached.length} calls to the PlantUML server`
        : `${hosts.length} calls in the trace, none to ${SERVER}`,
    ),
  );

  const fallback = appRequest(sim, APP.fallback);
  const fell: string[] = [];
  if (reviewPosts(sim, APP.fallback).length !== 1) {
    fell.push(`${reviewPosts(sim, APP.fallback).length} reviews posted`);
  }
  if (!fallback) fell.push("no review request");
  else {
    for (const marker of MERMAID_MARKERS) {
      if (!fallback.system.includes(marker)) fell.push(`no "${marker}"`);
    }
    if (JSON.stringify(fallback.tools) !== '["read-mermaid-syntaxes"]') {
      fell.push(`tools ${JSON.stringify(fallback.tools)}`);
    }
    if (/PlantUML|plantuml/.test(wording(fallback))) {
      fell.push("PlantUML wording after the fallback");
    }
  }
  if (linksIn(postedIn(sim, APP.fallback)).length > 0) {
    fell.push("an image link was posted");
  }
  const warnings = jobLogs(sim).filter(
    (line) => line.includes("diagramRuntime") && line.includes("uses mermaid"),
  );
  if (warnings.length !== 1) fell.push(`${warnings.length} warning lines`);
  else if (
    !warnings[0]!.includes(`repos[${DIAGRAM_APP_REPO}].diagramRuntime`)
  ) {
    fell.push(`warning "${warnings[0]}"`);
  }
  out.push(
    result(
      "a bad stored value does not stop the App review and the job log says why",
      fell,
      "review posted with Mermaid wording and tool, one warning line naming the field",
    ),
  );
  return out;
}

const scores = (sim: Sim): Score[] => {
  const fakeAi = sim.mode === "fake";
  const answers: string[] = [];
  for (const label of [LOCAL.plantuml, LOCAL.server]) {
    const last = reviewChat(runOf(sim, label)).at(-1);
    if (last) answers.push(last.answer);
  }
  const app = sim.trace.ai.find(
    (call: AiCall) =>
      call.step === APP.server && call.job === "review_pull_request",
  );
  if (app) answers.push(chatOf(app).answer);
  const blocks = answers.map((answer) => {
    // The answer is JSON: the bodies hold the diagram text.
    let text = answer;
    try {
      text = (
        (JSON.parse(answer) as { findings?: { body?: string }[] }).findings ??
        []
      )
        .map((item) => item.body ?? "")
        .join("\n");
    } catch {
      // A prose answer has no findings to read.
    }
    return {
      plantuml: plantumlBlocks(text),
      mermaid: (text.match(/```mermaid/g) ?? []).length,
    };
  });
  const asked = blocks.length;
  const sound = blocks.filter(
    (item) =>
      item.plantuml.length > 0 &&
      item.plantuml.every(
        (source) =>
          source.trimStart().startsWith("@startuml") &&
          source.trimEnd().endsWith("@enduml"),
      ),
  ).length;
  return [
    {
      name: "PlantUML reviews with a well formed diagram",
      value: asked ? sound / asked : null,
      detail: `${sound} of ${asked} PlantUML reviews had a block from @startuml to @enduml`,
      fakeAi,
    },
    {
      name: "Mermaid blocks in PlantUML reviews",
      value: blocks.reduce((sum, item) => sum + item.mermaid, 0),
      detail: "a PlantUML review should hold none",
      fakeAi,
    },
    {
      name: "diagrams per PlantUML review",
      value: asked
        ? blocks.reduce((sum, item) => sum + item.plantuml.length, 0) / asked
        : null,
      detail: "the prompt allows at most one",
      fakeAi,
    },
  ];
};

export default defineFlow({
  name: "diagram-runtime",
  description:
    "Diagram runtime: Mermaid by default, PlantUML source, or PlantUML links, from a flag and from a repository setting",
  ai: DIAGRAM_AI,
  steps,
  checks: (sim) => [...localChecks(sim), ...appChecks(sim)],
  scores,
});
