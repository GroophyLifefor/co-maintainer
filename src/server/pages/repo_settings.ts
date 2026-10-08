import { html, layout, repoNav, skSlot, text } from "./layout.ts";
import type { RepoRow } from "../../store/rows.ts";
import type { RepoConfig } from "../../config.ts";
import { parseRemakeCron } from "../../services/remake_cron.ts";
import { nextCronRun } from "../../util/cron.ts";
import { policySource } from "../../services/webhook.ts";
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

export function renderRepoSettings(
  username: string,
  repo: RepoRow,
  config: RepoConfig,
): Response {
  const name = repo.full_name;
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
  const skip =
    repo.skip_drafts && repo.skip_bots
      ? "both"
      : repo.skip_drafts
        ? "drafts"
        : repo.skip_bots
          ? "bots"
          : "none";
  return html(
    layout({
      title: `Settings · ${name}`,
      username,
      body: `<div class="wrap side">
  ${repoNav(name, "settings")}
  <div>
    <div class="crumbs"><a href="/">Repositories</a> /
      <a href="/repos/${text(name)}">${text(name)}</a> / Settings</div>
    <div class="pagehead"><div><h1>Settings</h1></div></div>
    <div class="card" data-async id="policy-card">
      ${skSlot()}
      <div class="hd"><h2>Who gets a review</h2></div>
      <div class="bd">
        <div class="field wide">
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
      <div class="hd"><h2>${source.legacy ? "Automatic review" : "How reviews run"}</h2></div>
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
        <div style="display:flex;align-items:center;gap:14px;margin-top:22px">
          <button class="tg${repo.use_codegraph === 1 ? " on" : ""}" id="codegraph"></button>
          <div>Let the review query the codebase's call graph (codegraph)</div>
        </div>
        <div class="hint">Slower and costs more tokens per review, try it before turning it on everywhere.</div>
      </div>
      <div class="ft"><button class="primary" id="save-auto">Save</button></div>
    </div>
    <div class="card" data-async>
      ${skSlot()}
      <div class="hd"><h2>How this repository is analyzed</h2></div>
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
      </div>
      <div class="ft"><button class="primary" id="save-init">Save</button></div>
    </div>
    <div class="card" data-async>
      ${skSlot()}
      <div class="hd"><h2>Scheduled sync</h2></div>
      <div class="bd">
        <p class="muted" style="margin:0 0 18px">Rebuild the knowledge for this repository on a schedule. Times are UTC and a sync runs at most once an hour.</p>
        <div class="field wide"><label>Cron schedule</label>
          <input id="cron" placeholder="0 3 * * 1" value="${text(config.remakeCron ?? "")}">
          <div class="hint">${text(cronHint(repo, config.remakeCron))}</div></div>
      </div>
      <div class="ft"><button class="primary" id="save-cron">Save</button></div>
    </div>
    <div class="card" data-async>
      ${skSlot()}
      <div class="hd"><h2>Remove</h2></div>
      <div class="bd" style="display:flex;align-items:center;gap:16px">
        <div class="txt">Stop reviewing this repository. Review history is kept.</div>
        <button id="remove" style="margin-left:auto;color:var(--red)">Remove repository</button>
      </div>
    </div>
  </div>
</div>
<script>
var repo = ${JSON.stringify(name)};
var P = ${scriptJson(policyData)};
var state = null;
var previewTimer = null;
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
function markCustom() {
  var select = document.getElementById("policy-template");
  if (select.value !== "legacy") select.value = "custom";
  describe();
  queuePreview();
}
function describe() {
  var value = document.getElementById("policy-template").value;
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
    var head = el("div", { style: "display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap" }, [
      el("strong", { text: "Rule " + (i + 1), style: "align-self:center" }),
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
document.getElementById("save-policy").addEventListener("click", function() {
  var value = document.getElementById("policy-template").value;
  save(this, { reviewPolicy: value === "legacy" ? "legacy" : toPolicy() });
});
loadState(P.policy);
describe();
if (P.current !== "legacy") queuePreview();

function save(btn, body) {
  run(btn, btn.closest("[data-async]"), async function() {
    await api("PATCH", "/api/repos/" + repo, body);
    location.reload();
  });
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
document.getElementById("save-init").addEventListener("click", function() {
  var num = function(id) {
    var v = document.getElementById(id).value.trim();
    return v === "" ? null : Number(v);
  };
  save(this, {
    maxPrMonths: num("months"),
    maxCommits: num("commits"),
    maxPullRequestChangeLines: num("lines"),
    maxComments: num("comments")
  });
});
document.getElementById("save-cron").addEventListener("click", function() {
  save(this, { remakeCron: document.getElementById("cron").value.trim() });
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
