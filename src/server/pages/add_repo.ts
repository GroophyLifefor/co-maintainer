import { html, layout, skSlot, text } from "./layout.ts";
import { readConfig } from "../../config.ts";
import { TEMPLATE_INFO } from "../../services/review_policy.ts";

export type RepoChoice = {
  fullName: string;
  account: string;
  alreadyActive: boolean;
};

export function renderAddRepo(
  username: string,
  picker: { repos: RepoChoice[]; error?: string },
): Response {
  const notice = picker.error
    ? `<div class="notice bad"><div class="txt">${text(picker.error)}</div></div>`
    : "";
  const groups = new Map<string, RepoChoice[]>();
  for (const repo of picker.repos) {
    const list = groups.get(repo.account) ?? [];
    list.push(repo);
    groups.set(repo.account, list);
  }
  const options = [...groups.entries()]
    .map(
      ([account, repos]) =>
        `<optgroup label="${text(account)}">${repos
          .map(
            (repo) =>
              `<option value="${text(repo.fullName)}"${
                repo.alreadyActive ? " disabled" : ""
              }>${text(repo.fullName)}${repo.alreadyActive ? " (already added)" : ""}</option>`,
          )
          .join("")}</optgroup>`,
    )
    .join("");
  const canAdd = picker.repos.some((repo) => !repo.alreadyActive);
  // What a repository added now would follow if nobody chooses: the server
  // default when there is one, otherwise the simple switches, which behave
  // exactly like "everyone".
  const serverDefault = readConfig().reviewPolicy;
  const choices = [
    ...TEMPLATE_INFO,
    ...(typeof serverDefault === "object"
      ? [
          {
            name: "__server",
            label: "Server default (custom rules)",
            description: "The custom rules set for the whole server.",
          },
        ]
      : []),
  ];
  const initial =
    typeof serverDefault === "string"
      ? serverDefault
      : typeof serverDefault === "object"
        ? "__server"
        : "everyone";
  const select = `<select id="repo"${canAdd ? "" : " disabled"}>
          <option value="">Choose a repository</option>
          ${options}
        </select>`;
  return html(
    layout({
      title: "Add repository · co-maintainer",
      username,
      body: `<div class="wrap" style="max-width:760px">
  <div class="crumbs"><a href="/">Repositories</a> / Add</div>
  <div class="pagehead">
    <div><h1>Add repository</h1>
      <p class="lead">Pick a repository this App can access. Nothing is read or written until you confirm the plan.</p></div>
  </div>
  ${notice}
  <div class="card" data-async>
    ${skSlot()}
    <div class="bd">
    <div class="field wide" style="display:flex;gap:10px;align-items:flex-end;margin:0">
      <div style="flex:1">
        <label>Repository</label>
        ${select}
      </div>
      <button class="primary" id="preview"${canAdd ? "" : " disabled"}>Preview</button>
    </div>
    <div id="plan" hidden></div>
  </div></div>
</div>
<script>
var plan = null;
var POLICY = ${JSON.stringify({ choices, initial }).replace(/</g, "\\u003c")};
function showPlan(data) {
  plan = data;
  var box = document.getElementById("plan");
  box.hidden = false;
  box.replaceChildren();
  var heading = document.createElement("h2");
  heading.textContent = "Plan for " + data.repo;
  box.appendChild(heading);
  var cmd = document.createElement("p");
  cmd.className = "mono";
  cmd.style.wordBreak = "break-all";
  cmd.textContent = data.command;
  box.appendChild(cmd);
  var est = data.estimate;
  var facts = document.createElement("p");
  facts.className = "muted";
  facts.textContent =
    "AI jobs: " + est.extract + " extract + " + est.synth + " synth" +
    ". Tokens: " + est.tokensIn[0].toLocaleString("en-US") + "-" +
    est.tokensIn[1].toLocaleString("en-US") + " in, " +
    est.tokensOut[0].toLocaleString("en-US") + "-" +
    est.tokensOut[1].toLocaleString("en-US") + " out" +
    ". Time: " + Math.round(est.seconds[0]) + "-" + Math.round(est.seconds[1]) + "s" +
    (est.usd
      ? ". Cost: $" + est.usd[0].toFixed(4) + "-$" + est.usd[1].toFixed(4)
      : ". Cost: unknown") +
    ". Basis: " + (est.estimateBasis === "history"
      ? "this repository's recorded jobs"
      : "the cm-dx-lab calibration") + ", an estimate, not a bill.";
  box.appendChild(facts);
  if (data.reasons && data.reasons.length) {
    var ul = document.createElement("ul");
    ul.className = "muted";
    data.reasons.forEach(function(reason) {
      var li = document.createElement("li");
      li.textContent = reason;
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }
  var choose = document.createElement("fieldset");
  choose.style.cssText = "border:0;padding:0;margin:14px 0 0";
  var legend = document.createElement("legend");
  legend.className = "muted";
  legend.style.padding = "0";
  legend.textContent = "Who gets a review";
  choose.appendChild(legend);
  POLICY.choices.forEach(function(item) {
    var id = "policy-" + item.name;
    var radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "policy";
    radio.id = id;
    radio.value = item.name;
    radio.checked = item.name === POLICY.initial;
    var label = document.createElement("label");
    label.setAttribute("for", id);
    label.style.cssText = "display:flex;align-items:flex-start;gap:8px;margin:6px 0";
    var body = document.createElement("span");
    var title = document.createElement("b");
    title.textContent = item.label;
    var desc = document.createElement("span");
    desc.className = "muted";
    desc.textContent = " " + item.description;
    body.appendChild(title);
    body.appendChild(desc);
    label.appendChild(radio);
    label.appendChild(body);
    choose.appendChild(label);
  });
  box.appendChild(choose);
  var row = document.createElement("div");
  row.style.display = "flex";
  row.style.gap = "8px";
  row.style.marginTop = "14px";
  var confirm = document.createElement("button");
  confirm.className = "primary";
  confirm.id = "confirm";
  confirm.textContent = "Add and start init";
  var cancel = document.createElement("button");
  cancel.className = "btn";
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", function() {
    plan = null;
    box.hidden = true;
    box.replaceChildren();
  });
  row.appendChild(confirm);
  row.appendChild(cancel);
  box.appendChild(row);
  confirm.addEventListener("click", function() {
    var repo = document.getElementById("repo").value.trim();
    if (!repo || !plan) return;
    var picked = document.querySelector('input[name="policy"]:checked');
    var body = { repo: repo, patch: plan.patch };
    // The server default is followed, not copied, so it is only sent when
    // this repository is meant to differ from it.
    if (picked && picked.value !== POLICY.initial) body.reviewPolicy = picked.value;
    postAndGo("/api/repos", body, "/activity", confirm);
  });
}
document.getElementById("preview").addEventListener("click", function() {
  var btn = this;
  var repo = document.getElementById("repo").value.trim();
  if (!repo) return;
  run(btn, btn.closest("[data-async]"), async function() {
    var data = await api("POST", "/api/repos/preview", { repo: repo });
    showPlan(data);
  });
});
</script>`,
    }),
  );
}
