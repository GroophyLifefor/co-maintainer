import { html, layout, repoTabs, skSlot, text } from "./layout.ts";
import type { RepoRow } from "../../store/rows.ts";
import { readConfig, type RepoConfig } from "../../config.ts";
import { parseRemakeCron } from "../../services/remake_cron.ts";
import { nextCronRun } from "../../util/cron.ts";
import { policySource } from "../../services/webhook.ts";
import { DEFAULT_REVIEW_SYSTEM_PROMPT_MAX_CHARS } from "../../review/system_prompt.ts";
import { latestSyncRateLimitWaits } from "../../services/rate_limit.ts";
import { rateLimitWaitNotice } from "./rate_limit_waits.ts";
import {
  aiCeiling,
  concurrencyWarnings,
  recommendConcurrency,
  resolveConcurrency,
} from "../../services/concurrency.ts";
import {
  ASSOCIATIONS,
  TEMPLATES,
  TEMPLATE_INFO,
  storedPolicyValue,
  withDefaults,
} from "../../services/review_policy.ts";

const ASSOCIATION_LABEL: Record<string, string> = {
  OWNER: "Owner",
  MEMBER: "Member",
  COLLABORATOR: "Collaborator",
  CONTRIBUTOR: "Earlier contributor",
  FIRST_TIME_CONTRIBUTOR: "First time contributor",
  FIRST_TIMER: "First timer",
  NONE: "No relation to the repository",
};

const DAILY_CRON = "0 3 * * *";
const WEEKLY_CRON = "0 3 * * 1";

const PROVIDER_LABEL: Record<string, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  "opencode-zen": "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  none: "No AI provider",
};

const POLICY_CHOICES: { value: string; label: string; sub: string }[] = [
  { value: "everyone", label: "Everyone", sub: "Except drafts and bots" },
  {
    value: "trusted-auto",
    label: "Trusted authors",
    sub: "Others when a maintainer asks",
  },
  {
    value: "on-request-only",
    label: "Only when asked",
    sub: "",
  },
];

/** JSON for an inline script: `<` is escaped so a rule name can never close
 * the script tag. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function cronHint(repo: RepoRow, expression: string | undefined): string {
  const notBuilt = repo.knowledge_built_at
    ? ""
    : " A schedule only runs after the first setup has finished.";
  if (!expression) {
    return `Leave blank to turn it off. For example, 0 3 * * 1 runs every Monday at 03:00.${notBuilt}`;
  }
  try {
    const next = nextCronRun(parseRemakeCron(expression), new Date());
    if (!next) return `This schedule has no run in the next year.${notBuilt}`;
    return `Next run ${next.toISOString().slice(0, 16).replace("T", " ")} UTC.${notBuilt}`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `This schedule is ignored, ${reason}.${notBuilt}`;
  }
}

function scheduleSelection(
  cron: string | undefined,
  draft: string | undefined,
): "off" | "daily" | "weekly" | "custom" {
  if (draft) return "custom";
  if (!cron) return "off";
  if (cron === DAILY_CRON) return "daily";
  if (cron === WEEKLY_CRON) return "weekly";
  return "custom";
}

function concurrencyButtons(selected: number): string {
  const buttons: string[] = [];
  for (let value = 1; value <= 16; value++) {
    buttons.push(
      `<button type="button" class="${value === selected ? "on" : ""}" data-v="${value}">${value}</button>`,
    );
  }
  return buttons.join("");
}

function speedBadge(kind: string, overridden: boolean): string {
  return `<span class="badge ${overridden ? "b-am" : "b-ne"}" id="${kind}-speed-badge">${overridden ? "Overridden" : "Default"}</span>`;
}

function warningBox(kind: string, message: string): string {
  return `<div class="alert b-am" data-warn="${kind}"><div class="txt">${text(message)}</div></div>`;
}

export function renderRepoSettings(
  username: string,
  repo: RepoRow,
  config: RepoConfig,
  probeReport?: Record<string, unknown>,
): Response {
  const name = repo.full_name;
  const latestSync = latestSyncRateLimitWaits(name);
  const waitNotice = rateLimitWaitNotice(
    latestSync.waits,
    latestSync.summary,
    "Last sync",
  );
  const source = policySource(repo);
  const stored = storedPolicyValue(source.policy);
  const current = source.legacy
    ? "legacy"
    : typeof stored === "string"
      ? stored
      : "custom";
  const templates = Object.fromEntries(
    Object.keys(TEMPLATES).map((key) => [key, withDefaults(TEMPLATES[key]!)]),
  );
  const policyData = {
    current,
    legacy: source.legacy,
    policy: source.legacy ? templates.everyone : source.policy,
    templates,
    info: TEMPLATE_INFO,
    associations: ASSOCIATIONS.map((value) => ({
      value,
      label: ASSOCIATION_LABEL[value],
    })),
  };
  const policyOptions = [
    ...TEMPLATE_INFO.map(
      (item) =>
        `<option value="${text(item.name)}"${current === item.name ? " selected" : ""}>${text(item.label)}</option>`,
    ),
    `<option value="custom"${current === "custom" ? " selected" : ""}>Custom rules</option>`,
    `<option value="legacy"${current === "legacy" ? " selected" : ""}>Simple switches</option>`,
  ].join("");
  const policyOverridden = repo.review_policy_json !== null;
  const policyChoices = POLICY_CHOICES.map((choice) => {
    const checked = current === choice.value;
    const sub =
      choice.value === "on-request-only"
        ? `Label <span class="mono">co-maintainer:review</span> or comment <span class="mono">/co-maintainer review</span>`
        : text(choice.sub);
    return `<label${checked ? ' class="on"' : ""}><input type="radio" name="policy-choice" value="${choice.value}"${checked ? " checked" : ""}><div><span>${text(choice.label)}</span><span class="sub">${sub}</span></div></label>`;
  }).join("");
  const skip =
    repo.skip_drafts && repo.skip_bots
      ? "both"
      : repo.skip_drafts
        ? "drafts"
        : repo.skip_bots
          ? "bots"
          : "none";

  const userConfig = readConfig();
  const provider = config.ai ?? userConfig.ai ?? "none";
  const lowModel = config.lowModel ?? userConfig.lowModel;
  const highModel = config.highModel ?? userConfig.highModel;
  const auth = config.auth ?? userConfig.auth ?? "gh";
  const providerLabel = PROVIDER_LABEL[provider] ?? provider;
  const resolved = resolveConcurrency(name, userConfig);
  const serverDefaults = resolveConcurrency(name, {
    ...userConfig,
    repos: {},
  });
  const ghOverride = config.ghConcurrent !== undefined;
  const aiOverride = config.aiConcurrent !== undefined;
  const ceiling = aiCeiling({ provider, lowModel, highModel });
  const freeModel =
    provider === "openrouter" &&
    [lowModel, highModel].some(
      (model) => model?.toLowerCase().includes(":free") === true,
    );
  const recommendation = (() => {
    if (probeReport) {
      const jobs =
        Number(probeReport.pullRequests ?? 0) +
        Number(probeReport.commits ?? 0);
      const recommended = recommendConcurrency({
        githubJobs: jobs,
        provider,
        lowModel,
        highModel,
      });
      if (recommended.gh >= 1 && recommended.ai >= 1) return recommended;
    }
    return resolved;
  })();
  const warningText = {
    free: "A free OpenRouter model is in use with AI concurrency above 1. Free models are slow and rate limited.",
    ceiling: `${providerLabel} allows about ${ceiling} AI calls at once. Calls above that will wait.`,
    pat: "A PAT allows 5,000 requests/hour. GitHub concurrency 8 can exhaust the quota.",
  };
  const warningKinds = new Set(
    concurrencyWarnings({
      provider,
      lowModel,
      highModel,
      gh: resolved.gh,
      ai: resolved.ai,
      auth,
    }).map((warning) => warning.kind),
  );
  const warningHtml = [
    warningKinds.has("free-model") ? warningBox("free", warningText.free) : "",
    warningKinds.has("provider-ceiling") && provider !== "none" && ceiling > 0
      ? warningBox("ceiling", warningText.ceiling)
      : "",
    warningKinds.has("pat-quota") ? warningBox("pat", warningText.pat) : "",
  ]
    .filter(Boolean)
    .join("");

  const configuredBlocking = config.reviewBlocking ?? userConfig.reviewBlocking;
  const blocking =
    configuredBlocking === "model" || configuredBlocking === "severity"
      ? configuredBlocking
      : "model";
  const cronSelection = scheduleSelection(
    config.remakeCron,
    config.remakeCronDraft,
  );
  const cronValue = config.remakeCronDraft ?? config.remakeCron ?? "";

  return html(
    layout({
      title: `Settings · ${name}`,
      username,
      active: "/",
      body: `<div class="wrap">
  ${repoTabs(name, "settings")}
  <div>
    <div class="crumbs"><a href="/">Repositories</a> /
      <a href="/repos/${text(name)}">${text(name)}</a> / Settings</div>
    <div class="pagehead"><div><h1>Settings</h1></div></div>
    ${waitNotice}
    <div class="card" data-async id="policy-card">
      ${skSlot()}
      <div class="hd"><h2>Who gets a review <span class="badge ${policyOverridden ? "b-am" : "b-ne"}">${policyOverridden ? "Overridden" : "Default"}</span></h2></div>
      <div class="bd">
        <div class="radio" id="policy-choices">${policyChoices}</div>
        <div class="field wide" style="margin-top:16px">
          <label for="policy-template">Policy</label>
          <select id="policy-template">${policyOptions}</select>
          <div class="hint" id="policy-desc"></div>
        </div>
        <div id="policy-body">
          <div class="notice info"><div class="txt"><b>In short</b>
            <ul id="policy-summary" aria-live="polite" style="margin:6px 0 0 18px;padding:0"></ul></div></div>
          <p id="policy-problem" class="muted" role="alert" hidden></p>
          <details id="policy-details" style="margin-top:14px">
            <summary>Edit the rules</summary>
            <p class="muted">The first rule that matches a pull request decides. If none matches, the last setting below decides.</p>
            <div id="rules"></div>
            <button class="btn sm" type="button" id="add-rule">Add rule</button>
            <div class="field" style="margin-top:14px">
              <label for="p-default">Any other pull request</label>
              <select id="p-default">
                <option value="review">Is reviewed automatically</option>
                <option value="on-request">Waits for a maintainer request</option>
                <option value="skip">Is not reviewed</option>
              </select>
            </div>
            <div class="two">
              <div class="field"><label for="p-label">Request label</label><input id="p-label"></div>
              <div class="field"><label for="p-command">Request comment</label><input id="p-command"></div>
              <div class="field"><label for="p-scope">A request covers</label>
                <select id="p-scope">
                  <option value="head">Only the commit it was made on</option>
                  <option value="pull-request">Every later push to the pull request</option>
                </select></div>
              <div class="field"><label for="p-max">Reviews per pull request</label>
                <input id="p-max" placeholder="No limit"></div>
            </div>
            <fieldset id="p-requesters" class="ticks">
              <legend>Who can ask for a review</legend>
            </fieldset>
          </details>
        </div>
      </div>
      <div class="ft"><button class="primary" id="save-policy">Save</button></div>
    </div>
    <div class="card" data-async>
      ${skSlot()}
      <div class="hd"><h2>How reviews run</h2></div>
      <div class="bd">
        ${
          source.legacy
            ? `<div id="switches"><div style="display:flex;align-items:center;gap:14px;margin-bottom:22px">
          <button class="tg${repo.auto_review === 1 ? " on" : ""}" id="auto"></button>
          <div>Review pull requests as they are pushed</div>
        </div>
        <div class="field">
          <label>Skip</label>
          <select id="skip">
            <option value="both"${skip === "both" ? " selected" : ""}>Drafts and bot pull requests</option>
            <option value="drafts"${skip === "drafts" ? " selected" : ""}>Drafts only</option>
            <option value="bots"${skip === "bots" ? " selected" : ""}>Bots only</option>
            <option value="none"${skip === "none" ? " selected" : ""}>Nothing</option>
          </select>
        </div></div>`
            : ""
        }
        <div class="field">
          <label>Review</label>
          <select id="scope">
            <option value="whole-pr"${repo.review_scope !== "incremental" ? " selected" : ""}>The whole pull request every time</option>
            <option value="incremental"${repo.review_scope === "incremental" ? " selected" : ""}>Only what changed since the last review</option>
          </select>
          <div class="hint">Reviewing only new changes costs less on long-running pull requests.</div>
        </div>
        <div class="field">
          <label>A finding blocks the pull request when</label>
          <div class="seg" id="blocking-seg">
            <button type="button" data-v="model" class="${blocking === "model" ? "on" : ""}">The model says so</button>
            <button type="button" data-v="severity" class="${blocking === "severity" ? "on" : ""}">Severity is Critical or High</button>
          </div>
          <div class="hint">Critical always blocks.</div>
          <div class="cli"><code>--review-blocking=model|severity</code></div>
        </div>
        <div style="display:flex;align-items:center;gap:14px;margin-top:22px">
          <button class="tg${repo.use_codegraph === 1 ? " on" : ""}" id="codegraph"></button>
          <div>Let the review query the codebase's call graph (codegraph)</div>
        </div>
        <div class="hint">Slower and costs more tokens per review, try it before turning it on everywhere.</div>
      </div>
      <div class="ft"><button class="primary" id="save-auto">Save</button></div>
    </div>
    <div class="card" data-async id="commit-watch-settings">
      ${skSlot()}
      <div class="hd"><h2>Commit watch</h2></div>
      <div class="bd">
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:22px">
          <button class="tg${repo.watch_open_issues === 0 ? "" : " on"}" id="watch-issues"></button>
          <div>Open a GitHub issue for each P0 and P1 finding</div>
        </div>
        <div class="field">
          <label>When pushes come in a row</label>
          <div class="seg" id="watch-mode-seg">
            <button type="button" data-v="queue" class="${repo.watch_push_mode === "cancel-and-merge" ? "" : "on"}">Review each push in turn</button>
            <button type="button" data-v="cancel-and-merge" class="${repo.watch_push_mode === "cancel-and-merge" ? "on" : ""}">Cancel and merge into the newest</button>
          </div>
          <div class="hint">Cancel and merge stops a waiting or running review and reviews the pushes together.</div>
        </div>
      </div>
      <div class="ft"><button class="primary" id="save-watch">Save</button></div>
    </div>
    <div class="card" data-async>
      ${skSlot()}
      <div class="hd"><h2>Custom review instructions</h2></div>
      <div class="bd">
        <p class="muted" style="margin:0 0 18px">Added to the reviewer's built-in instructions for every review of this repository, as a separate section. Leave blank for none.</p>
        <div class="field wide"><label for="system-prompt">Instructions</label>
          <textarea id="system-prompt" rows="8" placeholder="For example: prefer the project's own helpers over new dependencies.">${text(config.reviewSystemPrompt ?? "")}</textarea></div>
        <div class="field"><label for="system-prompt-max">Maximum characters</label>
          <input id="system-prompt-max" placeholder="${DEFAULT_REVIEW_SYSTEM_PROMPT_MAX_CHARS}" value="${text(config.reviewSystemPromptMaxChars ?? "")}">
          <div class="hint">Blank uses ${DEFAULT_REVIEW_SYSTEM_PROMPT_MAX_CHARS}. 0 or -1 means no limit.</div></div>
      </div>
      <div class="ft"><button class="primary" id="save-prompt">Save</button></div>
    </div>
    <div class="card" data-async>
      ${skSlot()}
      <div class="hd"><h2>What knowledge reads</h2></div>
      <div class="bd">
        <p class="muted" style="margin:0 0 18px">Used when the knowledge is rebuilt. Leave blank to use your account defaults.</p>
        <div class="two">
          <div class="field"><label>Months of pull requests</label>
            <input id="months" value="${text(config.maxPrMonths ?? "")}"></div>
          <div class="field"><label>Commits</label>
            <input id="commits" value="${text(config.maxCommits ?? "")}"></div>
          <div class="field"><label>Max lines per pull request</label>
            <input id="lines" value="${text(config.maxPullRequestChangeLines ?? "")}"></div>
          <div class="field"><label>Max comments per pull request</label>
            <input id="comments" value="${text(config.maxComments ?? "")}"></div>
        </div>
        <div class="field" style="margin-top:14px">
          <label>Speed</label>
          <div class="row speedrow">
            <div class="b"><p class="strong">GitHub requests at once</p></div>
            <div class="seg" data-kind="gh">${concurrencyButtons(resolved.gh)}</div>
            ${speedBadge("gh", ghOverride)}
          </div>
          <div class="row speedrow">
            <div class="b"><p class="strong">AI calls at once</p></div>
            <div class="seg" data-kind="ai">${concurrencyButtons(resolved.ai)}</div>
            ${speedBadge("ai", aiOverride)}
          </div>
          <div id="speed-warnings">${warningHtml}</div>
          <div class="cli"><code data-speed-cli>--gh-concurrent=${resolved.gh} --ai-concurrent=${resolved.ai}</code></div>
          <button class="btn sm" type="button" id="use-recommended" style="margin-top:8px">Use recommended (${recommendation.gh} · ${recommendation.ai})</button>
        </div>
        <div class="field" style="margin-top:14px">
          <label>Scheduled sync</label>
          <div class="seg" id="schedule-seg">
            <button type="button" data-v="off" class="${cronSelection === "off" ? "on" : ""}">Off</button>
            <button type="button" data-v="daily" class="${cronSelection === "daily" ? "on" : ""}">Daily</button>
            <button type="button" data-v="weekly" class="${cronSelection === "weekly" ? "on" : ""}">Weekly</button>
            <button type="button" data-v="custom" class="${cronSelection === "custom" ? "on" : ""}">Custom</button>
          </div>
          <div id="cron-wrap"${cronSelection === "custom" ? "" : " hidden"} style="margin-top:12px">
            <input id="cron" placeholder="0 3 * * 1" value="${text(cronValue)}">
            <div class="hint">${text(cronHint(repo, config.remakeCron))}</div>
          </div>
        </div>
      </div>
      <div class="ft"><button class="primary" id="save-init">Save</button><button class="primary" id="save-cron">Save schedule</button></div>
    </div>
    <div class="card red" data-async>
      ${skSlot()}
      <div class="hd"><h2>Danger</h2></div>
      <div class="bd" style="display:flex;align-items:center;gap:16px">
        <div class="txt">Stop reviewing this repository. Review history is kept.</div>
        <button id="remove" style="margin-left:auto;color:var(--red)">Remove repository</button>
      </div>
    </div>
    <div class="card" data-async id="settings-footer">
      <div class="bd" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <button class="primary" id="save-changes">Save changes</button>
        <button class="btn" type="button" id="reset-defaults">Reset to defaults</button>
      </div>
    </div>
  </div>
</div>
<script>
var repo = ${JSON.stringify(name)};
var P = ${scriptJson(policyData)};
var S = ${scriptJson({
        gh: resolved.gh,
        ai: resolved.ai,
        ghDefault: serverDefaults.gh,
        aiDefault: serverDefaults.ai,
        ghOverride,
        aiOverride,
        recommended: recommendation,
        freeModel,
        ceiling,
        auth,
        warningText: { ceiling: warningText.ceiling, pat: warningText.pat },
        cron: config.remakeCron ?? "",
        cronDraft: config.remakeCronDraft ?? "",
        cronSelection,
        blocking,
      })};
var state = null;
var previewTimer = null;
var speedOverridden = { gh: S.ghOverride, ai: S.aiOverride };
var DAILY = ${JSON.stringify(DAILY_CRON)};
var WEEKLY = ${JSON.stringify(WEEKLY_CRON)};
function el(tag, props, kids) {
  var node = document.createElement(tag);
  Object.keys(props || {}).forEach(function(key) {
    if (key === "text") node.textContent = props[key];
    else node.setAttribute(key, props[key]);
  });
  (kids || []).forEach(function(kid) { node.appendChild(kid); });
  return node;
}
function tri(v) { return v === true ? "yes" : v === false ? "no" : "any"; }
function unTri(v) { return v === "yes" ? true : v === "no" ? false : undefined; }
function csv(text) {
  return text.split(",").map(function(x) { return x.trim(); }).filter(Boolean);
}
function fromPolicy(policy) {
  return {
    rules: (policy.rules || []).map(function(rule) {
      var w = rule.when || {};
      var lines = w.changedLines || {};
      return {
        name: rule.name || "", action: rule.action,
        association: (w.association || []).slice(),
        fork: tri(w.fork), draft: tri(w.draft), bot: tri(w.bot),
        labels: (w.labels || []).join(", "),
        branches: (w.targetBranch || []).join(", "),
        min: lines.min === undefined ? "" : String(lines.min),
        max: lines.max === undefined ? "" : String(lines.max)
      };
    }),
    def: policy.default, label: policy.requestLabel,
    command: policy.requestCommand,
    requesters: policy.requesters.slice(), scope: policy.approvalScope,
    max: policy.maxRounds === undefined ? "" : String(policy.maxRounds)
  };
}
function toPolicy() {
  return {
    rules: state.rules.map(function(r) {
      var when = {};
      if (r.association.length) when.association = r.association;
      if (unTri(r.fork) !== undefined) when.fork = unTri(r.fork);
      if (unTri(r.draft) !== undefined) when.draft = unTri(r.draft);
      if (unTri(r.bot) !== undefined) when.bot = unTri(r.bot);
      if (csv(r.labels).length) when.labels = csv(r.labels);
      if (csv(r.branches).length) when.targetBranch = csv(r.branches);
      if (r.min.trim() !== "" || r.max.trim() !== "") {
        when.changedLines = {};
        if (r.min.trim() !== "") when.changedLines.min = Number(r.min);
        if (r.max.trim() !== "") when.changedLines.max = Number(r.max);
      }
      var out = { when: when, action: r.action };
      if (r.name.trim()) out.name = r.name.trim();
      return out;
    }),
    default: state.def, requestLabel: state.label,
    requestCommand: state.command, requesters: state.requesters,
    approvalScope: state.scope,
    maxRounds: state.max.trim() === "" ? undefined : Number(state.max)
  };
}
function syncPolicyRadios(value) {
  document.querySelectorAll('input[name="policy-choice"]').forEach(function(input) {
    var on = input.value === value;
    input.checked = on;
    var label = input.closest("label");
    if (label) label.classList.toggle("on", on);
  });
}
function markCustom() {
  var select = document.getElementById("policy-template");
  if (select.value !== "legacy") select.value = "custom";
  describe();
  queuePreview();
}
function describe() {
  var value = document.getElementById("policy-template").value;
  syncPolicyRadios(value);
  var text = "";
  if (value === "legacy") text = "The three switches below decide: automatic review on or off, and skipping drafts and bots.";
  else if (value === "custom") text = "Your own rules, edited below.";
  else P.info.forEach(function(item) { if (item.name === value) text = item.description; });
  document.getElementById("policy-desc").textContent = text;
  document.getElementById("policy-body").hidden = value === "legacy";
}
function queuePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(preview, 250);
}
async function preview() {
  var list = document.getElementById("policy-summary");
  var problem = document.getElementById("policy-problem");
  var saveBtn = document.getElementById("save-policy");
  if (document.getElementById("policy-template").value === "legacy") return;
  try {
    var data = await api("POST", "/api/repos/policy-preview", { policy: toPolicy() });
    list.replaceChildren();
    data.summary.forEach(function(line) {
      list.appendChild(el("li", { text: line }));
    });
    problem.hidden = true;
    saveBtn.disabled = false;
  } catch (error) {
    problem.textContent = "This policy cannot be saved yet: " + error.message;
    problem.hidden = false;
    saveBtn.disabled = true;
  }
}
function field(id, labelText, control) {
  return el("div", { "class": "field" }, [el("label", { "for": id, text: labelText }), control]);
}
function tickList(container, name, values, onChange) {
  P.associations.forEach(function(a) {
    var id = name + a.value;
    var box = el("input", { type: "checkbox", id: id });
    box.checked = values().indexOf(a.value) !== -1;
    box.addEventListener("change", function() {
      var next = P.associations.map(function(x) { return x.value; }).filter(function(v) {
        return v === a.value ? box.checked : values().indexOf(v) !== -1;
      });
      onChange(next);
      markCustom();
    });
    container.appendChild(el("label", { "for": id }, [box, el("span", { text: a.label })]));
  });
}
function renderRules() {
  var box = document.getElementById("rules");
  box.replaceChildren();
  state.rules.forEach(function(rule, i) {
    var pre = "r" + i + "-";
    var bind = function(node, key) {
      node.addEventListener("input", function() { rule[key] = node.value; markCustom(); });
      return node;
    };
    var pick = function(id, key, options) {
      var node = el("select", { id: id }, options.map(function(o) {
        return el("option", { value: o[0], text: o[1] });
      }));
      node.value = rule[key];
      node.addEventListener("change", function() { rule[key] = node.value; markCustom(); });
      return node;
    };
    var move = function(text, label, to, disabled) {
      var btn = el("button", { "class": "btn sm", type: "button", text: text, "aria-label": label });
      btn.disabled = disabled;
      btn.addEventListener("click", function() {
        state.rules.splice(to, 0, state.rules.splice(i, 1)[0]);
        renderRules(); markCustom();
      });
      return btn;
    };
    var del = el("button", { "class": "btn sm", type: "button", text: "Remove", "aria-label": "Remove rule " + (i + 1) });
    del.addEventListener("click", function() {
      state.rules.splice(i, 1);
      renderRules(); markCustom();
    });
    var head = el("div", { "class": "rule-head" }, [
      el("strong", { text: "Rule " + (i + 1) }),
      field(pre + "name", "Name (optional)", bind(el("input", { id: pre + "name", value: rule.name }), "name")),
      field(pre + "action", "Then", pick(pre + "action", "action", [
        ["review", "Review it"], ["on-request", "Wait for a request"], ["skip", "Do not review it"]
      ]))
    ]);
    var authors = el("fieldset", { "class": "ticks" }, [
      el("legend", { text: "When the author is (none ticked means anyone)" })
    ]);
    tickList(authors, pre + "a-", function() { return rule.association; }, function(next) { rule.association = next; });
    var yesNo = [["any", "Either"], ["yes", "Yes"], ["no", "No"]];
    var flags = el("div", { "class": "two" }, [
      field(pre + "fork", "Opened from a fork", pick(pre + "fork", "fork", yesNo)),
      field(pre + "draft", "Is a draft", pick(pre + "draft", "draft", yesNo)),
      field(pre + "bot", "Is by a bot", pick(pre + "bot", "bot", yesNo)),
      field(pre + "labels", "Has one of these labels (comma separated)", bind(el("input", { id: pre + "labels", value: rule.labels }), "labels")),
      field(pre + "branches", "Targets one of these branches (comma separated)", bind(el("input", { id: pre + "branches", value: rule.branches }), "branches")),
      field(pre + "min", "Changes at least this many lines", bind(el("input", { id: pre + "min", value: rule.min }), "min")),
      field(pre + "max", "Changes at most this many lines", bind(el("input", { id: pre + "max", value: rule.max }), "max"))
    ]);
    box.appendChild(el("div", { "class": "rule" }, [
      head, authors, flags,
      el("div", { style: "display:flex;gap:8px;margin-top:8px" }, [
        move("Move up", "Move rule " + (i + 1) + " up", i - 1, i === 0),
        move("Move down", "Move rule " + (i + 1) + " down", i + 1, i === state.rules.length - 1),
        del
      ])
    ]));
  });
}
function renderSettings() {
  document.getElementById("p-default").value = state.def;
  document.getElementById("p-label").value = state.label;
  document.getElementById("p-command").value = state.command;
  document.getElementById("p-scope").value = state.scope;
  document.getElementById("p-max").value = state.max;
  var box = document.getElementById("p-requesters");
  box.querySelectorAll("label").forEach(function(n) { n.remove(); });
  tickList(box, "p-req-", function() { return state.requesters; }, function(next) { state.requesters = next; });
  syncPolicyVisibility();
}
function syncPolicyVisibility() {
  var switches = document.getElementById("switches");
  if (!switches) return;
  switches.hidden = document.getElementById("policy-template").value !== "legacy";
}
function loadState(policy) {
  state = fromPolicy(policy);
  renderRules();
  renderSettings();
}
[["p-default", "def"], ["p-label", "label"], ["p-command", "command"], ["p-scope", "scope"], ["p-max", "max"]].forEach(function(pair) {
  var node = document.getElementById(pair[0]);
  node.addEventListener(node.tagName === "SELECT" ? "change" : "input", function() {
    state[pair[1]] = node.value;
    markCustom();
  });
});
document.getElementById("add-rule").addEventListener("click", function() {
  state.rules.push({ name: "", action: "skip", association: [], fork: "any", draft: "any", bot: "any", labels: "", branches: "", min: "", max: "" });
  renderRules(); markCustom();
  var last = document.getElementById("r" + (state.rules.length - 1) + "-name");
  if (last) last.focus();
});
document.getElementById("policy-template").addEventListener("change", function() {
  if (P.templates[this.value]) loadState(P.templates[this.value]);
  describe();
  queuePreview();
});
document.querySelectorAll('input[name="policy-choice"]').forEach(function(input) {
  input.addEventListener("change", function() {
    var select = document.getElementById("policy-template");
    select.value = this.value;
    if (P.templates[this.value]) loadState(P.templates[this.value]);
    describe();
    queuePreview();
  });
});
document.getElementById("save-policy").addEventListener("click", function() {
  var value = document.getElementById("policy-template").value;
  save(this, { reviewPolicy: value === "legacy" ? "legacy" : toPolicy() });
});
loadState(P.policy);
describe();
if (P.current !== "legacy") queuePreview();

function save(btn, body) {
  var card = btn.closest("[data-async]");
  run(btn, card, async function() {
    await api("PATCH", "/api/repos/" + repo, body);
    saved(btn, card);
    renderSettings();
    describe();
  });
}
function speedSegment(kind) {
  return document.querySelector('.seg[data-kind="' + kind + '"]');
}
function selectedSpeed(kind) {
  var seg = speedSegment(kind);
  var on = seg && seg.querySelector("button.on");
  return on ? Number(on.getAttribute("data-v")) : 0;
}
function setSpeed(kind, value, overridden) {
  var seg = speedSegment(kind);
  if (seg) {
    seg.querySelectorAll("button").forEach(function(btn) {
      btn.classList.toggle("on", Number(btn.getAttribute("data-v")) === Number(value));
    });
  }
  speedOverridden[kind] = overridden;
  var badge = document.getElementById(kind + "-speed-badge");
  if (badge) {
    badge.textContent = overridden ? "Overridden" : "Default";
    badge.className = "badge " + (overridden ? "b-am" : "b-ne");
  }
}
function updateSpeedCli() {
  var cli = document.querySelector("[data-speed-cli]");
  if (cli) cli.textContent = "--gh-concurrent=" + selectedSpeed("gh") + " --ai-concurrent=" + selectedSpeed("ai");
}
function renderSpeedWarnings() {
  var host = document.getElementById("speed-warnings");
  if (!host) return;
  var ai = selectedSpeed("ai");
  var gh = selectedSpeed("gh");
  var items = [];
  if (S.freeModel && ai >= 2) items.push({ kind: "free", text: "A free OpenRouter model " + "is in use with AI concurrency above 1. Free models are slow and rate limited." });
  if (S.ceiling > 0 && ai > S.ceiling) items.push({ kind: "ceiling", text: S.warningText.ceiling });
  if (S.auth === "pat" && gh >= 8) items.push({ kind: "pat", text: S.warningText.pat });
  host.replaceChildren();
  items.forEach(function(item) {
    var box = document.createElement("div");
    box.className = "alert b-am";
    box.setAttribute("data-warn", item.kind);
    var txt = document.createElement("div");
    txt.className = "txt";
    txt.textContent = item.text;
    box.appendChild(txt);
    host.appendChild(box);
  });
}
document.querySelectorAll('.seg[data-kind="gh"] button, .seg[data-kind="ai"] button').forEach(function(btn) {
  btn.addEventListener("click", function() {
    var kind = this.parentNode.getAttribute("data-kind");
    setSpeed(kind, Number(this.getAttribute("data-v")), true);
    updateSpeedCli();
    renderSpeedWarnings();
  });
});
var useRecommended = document.getElementById("use-recommended");
if (useRecommended) {
  useRecommended.addEventListener("click", function() {
    setSpeed("gh", S.recommended.gh, true);
    setSpeed("ai", S.recommended.ai, true);
    updateSpeedCli();
    renderSpeedWarnings();
  });
}
function scheduleSegment() {
  return document.getElementById("schedule-seg");
}
function selectedSchedule() {
  var seg = scheduleSegment();
  var on = seg && seg.querySelector("button.on");
  return on ? on.getAttribute("data-v") : "off";
}
function setSchedule(value) {
  var seg = scheduleSegment();
  if (seg) {
    seg.querySelectorAll("button").forEach(function(btn) {
      btn.classList.toggle("on", btn.getAttribute("data-v") === value);
    });
  }
  var wrap = document.getElementById("cron-wrap");
  var cron = document.getElementById("cron");
  if (value === "off" && cron) cron.value = "";
  else if (value === "daily" && cron) cron.value = DAILY;
  else if (value === "weekly" && cron) cron.value = WEEKLY;
  if (wrap) wrap.hidden = value !== "custom";
}
function scheduleValue() {
  var value = selectedSchedule();
  if (value === "daily") return DAILY;
  if (value === "weekly") return WEEKLY;
  if (value === "off") return "";
  var cron = document.getElementById("cron");
  return cron ? cron.value.trim() : "";
}
if (scheduleSegment()) {
  scheduleSegment().querySelectorAll("button").forEach(function(btn) {
    btn.addEventListener("click", function() {
      setSchedule(this.getAttribute("data-v"));
    });
  });
}
function selectedBlocking() {
  var on = document.querySelector("#blocking-seg button.on");
  return on ? on.getAttribute("data-v") : "model";
}
document.querySelectorAll("#blocking-seg button").forEach(function(btn) {
  btn.addEventListener("click", function() {
    document.querySelectorAll("#blocking-seg button").forEach(function(other) {
      other.classList.toggle("on", other === btn);
    });
  });
});
function promptMaxValue() {
  var raw = document.getElementById("system-prompt-max").value.trim();
  if (raw === "") return { ok: true, value: null };
  var value = Number(raw);
  if (!Number.isInteger(value)) return { ok: false };
  return { ok: true, value: value };
}
function initNumber(id) {
  var value = document.getElementById(id).value.trim();
  return value === "" ? null : Number(value);
}
function cronProblem(value) {
  if (!value) return "";
  if (value.trim().split(/\\s+/).length !== 5) {
    return "A cron expression needs 5 fields: minute, hour, day of month, month, day of week.";
  }
  return "";
}
document.getElementById("save-auto").addEventListener("click", function() {
  var body = {
    reviewScope: document.getElementById("scope").value,
    useCodegraph: document.getElementById("codegraph").classList.contains("on")
  };
  if (document.getElementById("auto")) {
    var skip = document.getElementById("skip").value;
    body.autoReview = document.getElementById("auto").classList.contains("on");
    body.skipDrafts = skip === "both" || skip === "drafts";
    body.skipBots = skip === "both" || skip === "bots";
  }
  save(this, body);
});
if (document.getElementById("auto")) {
  document.getElementById("auto").addEventListener("click", function() {
    this.classList.toggle("on");
  });
}
document.getElementById("codegraph").addEventListener("click", function() {
  this.classList.toggle("on");
});
document.getElementById("watch-issues").addEventListener("click", function() {
  this.classList.toggle("on");
});
function selectedWatchMode() {
  var on = document.querySelector("#watch-mode-seg button.on");
  return on ? on.getAttribute("data-v") : "queue";
}
document.querySelectorAll("#watch-mode-seg button").forEach(function(btn) {
  btn.addEventListener("click", function() {
    document.querySelectorAll("#watch-mode-seg button").forEach(function(b) {
      b.classList.toggle("on", b === btn);
    });
  });
});
function watchBody() {
  return {
    watchOpenIssues: document.getElementById("watch-issues").classList.contains("on"),
    watchPushMode: selectedWatchMode()
  };
}
document.getElementById("save-watch").addEventListener("click", function() {
  save(this, watchBody());
});
document.getElementById("save-init").addEventListener("click", function() {
  save(this, {
    maxPrMonths: initNumber("months"),
    maxCommits: initNumber("commits"),
    maxPullRequestChangeLines: initNumber("lines"),
    maxComments: initNumber("comments")
  });
});
document.getElementById("save-cron").addEventListener("click", function() {
  var cron = scheduleValue();
  var problem = cronProblem(cron);
  if (problem) {
    toast(problem);
    return;
  }
  save(this, { remakeCron: cron });
});
document.getElementById("save-prompt").addEventListener("click", function() {
  var max = promptMaxValue();
  if (!max.ok) {
    toast("Maximum characters must be a whole number, or blank for the default.");
    return;
  }
  save(this, {
    reviewSystemPrompt: document.getElementById("system-prompt").value,
    reviewSystemPromptMaxChars: max.value
  });
});
document.getElementById("save-changes").addEventListener("click", function() {
  var max = promptMaxValue();
  if (!max.ok) {
    toast("Maximum characters must be a whole number, or blank for the default.");
    return;
  }
  var select = document.getElementById("policy-template");
  var cron = scheduleValue();
  var problem = cronProblem(cron);
  if (problem) {
    toast(problem);
    return;
  }
  var body = {
    reviewPolicy: select.value === "legacy" ? "legacy" : toPolicy(),
    reviewScope: document.getElementById("scope").value,
    useCodegraph: document.getElementById("codegraph").classList.contains("on"),
    reviewSystemPrompt: document.getElementById("system-prompt").value,
    reviewSystemPromptMaxChars: max.value,
    remakeCron: cron,
    reviewBlocking: selectedBlocking(),
    ghConcurrent: speedOverridden.gh ? selectedSpeed("gh") : null,
    aiConcurrent: speedOverridden.ai ? selectedSpeed("ai") : null,
    maxPrMonths: initNumber("months"),
    maxCommits: initNumber("commits"),
    maxPullRequestChangeLines: initNumber("lines"),
    maxComments: initNumber("comments"),
    watchOpenIssues: watchBody().watchOpenIssues,
    watchPushMode: watchBody().watchPushMode
  };
  if (select.value === "legacy") {
    var auto = document.getElementById("auto");
    if (auto) {
      var skip = document.getElementById("skip").value;
      body.autoReview = auto.classList.contains("on");
      body.skipDrafts = skip === "both" || skip === "drafts";
      body.skipBots = skip === "both" || skip === "bots";
    }
  }
  save(this, body);
});
document.getElementById("reset-defaults").addEventListener("click", function() {
  setSpeed("gh", S.ghDefault, false);
  setSpeed("ai", S.aiDefault, false);
  updateSpeedCli();
  renderSpeedWarnings();
});
document.getElementById("remove").addEventListener("click", function() {
  if (!confirm("Stop reviewing this repository?")) return;
  var btn = this;
  run(btn, btn.closest("[data-async]"), async function() {
    await api("DELETE", "/api/repos/" + repo);
    location.href = "/";
  });
});
</script>`,
    }),
  );
}
