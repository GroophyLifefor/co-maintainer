/** `/setup`: the setup checklist as a step by step wizard. The four required
 * steps come from `setupChecklist`, the same list the home banner and the
 * menu count, then one optional step shows how a review comment looks. Each
 * step is its own URL, `?step=<id>`, so Back and Next are plain links. */
import { escapeHtml, html, layout, text } from "./layout.ts";
import { badge, icon } from "./ui.ts";
import type { SetupItem } from "../../services/setup_checklist.ts";
import { isBlocking, type ReviewBlocking } from "../../review/blocking.ts";

/** The optional last step, outside the required count. */
export const LOOK_STEP = "look";

type Step = SetupItem & { optional?: boolean };

function lookStep(blocking: ReviewBlocking | undefined): Step {
  return {
    id: LOOK_STEP,
    title: "How reviews look",
    detail: blocking
      ? "The blocking rule is saved. Change it here any time."
      : "Pick how a review decides a blocking finding, and see a review comment change as you go.",
    done: blocking !== undefined,
    href: `/setup?step=${LOOK_STEP}`,
    linkLabel: "Choose",
    optional: true,
  };
}

/** Two findings whose model labels disagree with the severity rule, so the
 * preview shows what each rule changes. */
const SAMPLE = [
  {
    severity: "P1",
    label: "non-blocking",
    path: "src/cache.ts",
    symbol: "readEntry",
    title: "The cache key leaves out the locale",
    body: "Two users with different locales read each other's entry.",
    reference: "Guide rule: Cache keys name every input",
  },
  {
    severity: "P2",
    label: "blocking",
    path: "src/format.ts",
    symbol: "formatDuration",
    title: "Durations over a day lose their days",
    body: "A 26 hour job shows as 2 hours.",
    reference: "Codebase convention: Durations go through formatDuration",
  },
];

/** One finding as the review comment heads it, for one blocking rule. */
function findingHtml(
  finding: (typeof SAMPLE)[number],
  mode: ReviewBlocking,
): string {
  const blocks = isBlocking(mode, {
    severity: finding.severity,
    text: `[${finding.severity} · ${finding.label}]`,
  });
  return `<div class="rv-finding when-${mode}">
    <p class="rv-h"><b>[${finding.severity} · ${blocks ? "blocking" : "non-blocking"}]</b> <code>${text(
      finding.path,
    )}</code>: <code>${text(finding.symbol)}</code></p>
    <p><b>${text(finding.title)}</b></p>
    <p>${text(finding.body)}</p>
    <p class="rv-refs muted">References: ${text(finding.reference)}</p>
  </div>`;
}

function summaryHtml(mode: ReviewBlocking): string {
  const blocking = SAMPLE.filter((finding) =>
    isBlocking(mode, {
      severity: finding.severity,
      text: `[${finding.severity} · ${finding.label}]`,
    }),
  ).length;
  return `<p class="when-${mode}">Summary: 2 new findings, ${blocking} blocking. ${
    blocking > 0 ? "Changes requested." : "No blocking findings."
  }</p>`;
}

/** A review comment that follows the options as they change. Every variant
 * is in the page, the options only switch which one shows. */
function lookBody(blocking: ReviewBlocking | undefined): string {
  const current = blocking ?? "model";
  const option = (
    name: string,
    value: string,
    label: string,
    hint: string,
    on: boolean,
  ) =>
    `<label class="wz-choice"><input type="radio" name="${name}" value="${value}"${
      on ? " checked" : ""
    } data-look="${name}"> <span><b>${text(label)}</b><span class="muted">${text(hint)}</span></span></label>`;
  const diagram = {
    mermaid: `<pre class="rv-code when-mermaid">\`\`\`mermaid
flowchart LR
  request --> readEntry --> cache
\`\`\`</pre>`,
    plantuml: `<pre class="rv-code when-plantuml">\`\`\`plantuml
@startuml
request -> readEntry
readEntry -> cache
@enduml
\`\`\`</pre>`,
    server: `<p class="rv-code when-plantuml-server">A diagram image from the PlantUML server, linked in the comment.</p>`,
  };
  return `<div class="wz-look">
    <div class="wz-options">
      <fieldset>
        <legend>Blocking rule</legend>
        ${option("blocking", "model", "The model decides", "The model labels each finding. A P0 always blocks.", current === "model")}
        ${option("blocking", "severity", "By severity", "P0 and P1 block, P2 and P3 never do, whatever the model said.", current === "severity")}
      </fieldset>
      <fieldset>
        <legend>Diagram language</legend>
        ${option("diagram", "mermaid", "Mermaid", "GitHub draws it in the comment.", true)}
        ${option("diagram", "plantuml", "PlantUML", "A PlantUML block.", false)}
        ${option("diagram", "plantuml-server", "PlantUML server", "An image link from a PlantUML server.", false)}
        <p class="hint">Set per repository in its Repository settings.</p>
      </fieldset>
      <fieldset>
        <legend>References in the comment</legend>
        ${option("refs", "off", "Leave them out", "They stay on the dashboard.", true)}
        ${option("refs", "on", "Show them", "Each finding names the rule it rests on.", false)}
        <p class="hint">Set per repository in its Repository settings.</p>
      </fieldset>
      <button class="primary" type="button" id="save-look">Save blocking rule</button>
    </div>
    <div class="rv-preview" id="rv-preview" data-blocking="${current}" data-diagram="mermaid" data-refs="off" aria-live="polite">
      <div class="rv-head">${icon("message-square-text")}<b>co-maintainer</b> <span class="muted">reviewed this pull request</span></div>
      <div class="rv-body">
        ${summaryHtml("model")}${summaryHtml("severity")}
        ${SAMPLE.map((finding) => findingHtml(finding, "model") + findingHtml(finding, "severity")).join("")}
        <p class="muted">How the change moves through the code:</p>
        ${diagram.mermaid}${diagram.plantuml}${diagram.server}
      </div>
    </div>
  </div>`;
}

const LOOK_SCRIPT = `
(function() {
  var preview = document.getElementById("rv-preview");
  if (!preview) return;
  document.querySelectorAll("[data-look]").forEach(function(input) {
    input.addEventListener("change", function() {
      preview.setAttribute("data-" + input.getAttribute("data-look"), input.value);
    });
  });
  document.getElementById("save-look").addEventListener("click", function() {
    var btn = this;
    var card = btn.closest("[data-async]");
    var value = document.querySelector('input[name="blocking"]:checked').value;
    run(btn, card, async function() {
      await api("PUT", "/api/settings", { reviewBlocking: value });
      saved(btn, card);
    });
  });
})();
`;

export function renderSetup(
  username: string,
  checklist: SetupItem[],
  opts: { step?: string; blocking?: ReviewBlocking } = {},
): Response {
  const doneCount = checklist.filter((item) => item.done).length;
  const allDone = doneCount === checklist.length;
  const steps: Step[] = [...checklist, lookStep(opts.blocking)];
  // Without a step in the URL, the first step not done yet.
  const firstOpen = steps.findIndex((step) => !step.done);
  const asked = steps.findIndex((step) => step.id === opts.step);
  const at = asked >= 0 ? asked : firstOpen >= 0 ? firstOpen : steps.length - 1;
  const step = steps[at]!;
  const href = (index: number) => `/setup?step=${steps[index]!.id}`;
  const progress = `<ol class="wz-progress" aria-label="Setup steps">${steps
    .map(
      (item, index) =>
        `<li class="${item.done ? "done" : ""}${index === at ? " on" : ""}"><a href="${href(
          index,
        )}"${index === at ? ` aria-current="step"` : ""}><span class="n">${
          item.done ? "✓" : index + 1
        }</span><span class="l">${text(item.title)}${
          item.optional ? `<span class="muted"> (optional)</span>` : ""
        }</span></a></li>`,
    )
    .join("")}</ol>`;
  const status = step.done
    ? badge("emerald", "Done", { icon: "circle-check" })
    : step.optional
      ? badge("neutral", "Optional")
      : badge("amber", "To do");
  const body =
    step.id === LOOK_STEP
      ? lookBody(opts.blocking)
      : `<p class="lead">${text(step.detail)}</p>
      <p><a class="btn${step.done ? " out" : " primary"}" href="${escapeHtml(step.href)}">${
        step.done ? "Change" : text(step.linkLabel)
      }${icon("arrow-right", "arr")}</a></p>${
        step.done
          ? `<p class="muted">This step is done. Go on to the next one or change it.</p>`
          : `<p class="muted">Come back here when it is done, or skip it for now.</p>`
      }`;
  const back =
    at > 0
      ? `<a class="btn out" href="${href(at - 1)}" rel="prev">Back</a>`
      : `<button class="btn out" type="button" disabled>Back</button>`;
  const next =
    at < steps.length - 1
      ? `<a class="btn${step.done || step.optional ? " primary" : ""}" href="${href(
          at + 1,
        )}" rel="next">${step.done || step.optional ? "Next" : "Skip for now"}</a>`
      : `<a class="btn primary" href="/">Finish</a>`;
  return html(
    layout({
      title: "Get started · co-maintainer",
      username,
      active: "/setup",
      body: `<div class="wrap${step.id === LOOK_STEP ? "" : " narrow"}">
  <div class="pagehead">
    <div><h1>${allDone ? "All set" : "Get started"}</h1>
      <p class="lead">${doneCount} of ${checklist.length} done · step ${at + 1} of ${steps.length}</p></div>
  </div>
  ${progress}
  <div class="card wz-step" data-async data-step="${escapeHtml(step.id)}">
    <div class="hd"><h2>${text(step.title)}</h2>${status}</div>
    <div class="bd">${body}</div>
    <div class="ft wz-nav">${back}<span class="sp"></span>${next}</div>
  </div>
</div>${step.id === LOOK_STEP ? `<script>${LOOK_SCRIPT}</script>` : ""}`,
    }),
  );
}
