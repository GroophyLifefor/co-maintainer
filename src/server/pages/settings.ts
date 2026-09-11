import { html, layout, skSlot, text } from "./layout.ts";
import type { UserConfig } from "../../config.ts";
import denoConfig from "../../../deno.json" with { type: "json" };

const SOURCE_URL = "https://github.com/GroophyLifefor/co-maintainer";

export function renderSettings(
  username: string,
  config: UserConfig,
  webhookUrl: string,
): Response {
  const aiOk = Boolean(config.ai && config.ai !== "none" && config.token);
  const ghOk = Boolean(
    config.auth === "gh" || (config.auth === "pat" && config.githubPat),
  );
  const appOk = Boolean(config.githubAppId && config.githubAppPrivateKey);
  return html(layout({
    title: "Settings · co-maintainer",
    username,
    active: "settings",
    body: `<div class="wrap side">
  <aside>
    <p class="lbl">Settings</p>
    <nav>
      <a href="/settings" class="on">Models and keys</a>
      <a href="#github">GitHub</a>
      <a href="#defaults">Defaults</a>
      <a href="#access">Access</a>
      <a href="#about">About</a>
    </nav>
  </aside>
  <div>
    <div class="pagehead"><div><h1>Settings</h1>
      <p class="lead">Used by every repository unless it overrides them.</p></div></div>
    <div class="card" data-async>
      ${skSlot()}
      <div class="hd"><h2>Models and API key</h2>
        <span class="st ${aiOk ? "ok" : "warn"}" style="margin-left:auto">${
      aiOk ? "Configured" : "Not set"
    }</span></div>
      <div class="bd">
        <div class="field"><label>Provider</label>
          <select id="ai">
            <option value="none"${
      !config.ai || config.ai === "none" ? " selected" : ""
    }>None</option>
            <option value="openrouter"${
      config.ai === "openrouter" ? " selected" : ""
    }>OpenRouter</option>
            <option value="hetzner"${
      config.ai === "hetzner" ? " selected" : ""
    }>Hetzner</option>
          </select></div>
        <div class="field"><label>API key</label>
          <input id="token" type="password" placeholder="Leave blank to keep the current key">
          <div class="hint">${
      config.token ? "A key is saved" : "No key saved"
    }</div></div>
        <div class="two" style="max-width:none">
          <div class="field"><label>Main model</label>
            <input id="high" value="${text(config.highModel ?? "")}">
            <div class="hint">Writes reviews</div></div>
          <div class="field"><label>Cheap model</label>
            <input id="low" value="${text(config.lowModel ?? "")}">
            <div class="hint">Reads history when setting up a repository</div></div>
        </div>
      </div>
      <div class="ft"><button class="primary" id="save-ai">Save</button></div>
    </div>
    <div class="card" id="github" data-async>
      ${skSlot()}
      <div class="hd"><h2>GitHub</h2>
        <span class="st ${ghOk ? "ok" : "warn"}" style="margin-left:auto">${
      ghOk ? "Configured" : "Not set"
    }</span></div>
      <div class="bd">
        <div class="field"><label>Access</label>
          <select id="auth">
            <option value="gh"${
      config.auth !== "pat" ? " selected" : ""
    }>gh CLI</option>
            <option value="pat"${
      config.auth === "pat" ? " selected" : ""
    }>Personal access token</option>
          </select></div>
        <div class="field"><label>Personal access token</label>
          <input id="pat" type="password" placeholder="Leave blank to keep the current token"></div>
      </div>
      <div class="ft"><button class="primary" id="save-gh">Save</button></div>
    </div>
    <div class="card" data-async>
      ${skSlot()}
      <div class="hd"><h2>GitHub App</h2>
        <span class="st ${appOk ? "ok" : "warn"}" style="margin-left:auto">${
      appOk ? "Configured" : "Not set"
    }</span></div>
      <div class="bd">
        <p class="muted" style="margin:0 0 16px">Needed to post reviews on pull requests.</p>
        <div class="two" style="max-width:none">
          <div class="field"><label>App ID</label>
            <input id="app-id" value="${text(config.githubAppId ?? "")}"></div>
          <div class="field"><label>Webhook address</label>
            <input value="${text(webhookUrl)}" readonly></div>
        </div>
        <div class="field"><label>Private key</label>
          <input id="app-key" type="password" placeholder="Leave blank to keep the current key"></div>
        <div class="field"><label>Webhook secret</label>
          <input id="hook-secret" type="password" placeholder="Leave blank to keep the current secret"></div>
      </div>
      <div class="ft"><button class="primary" id="save-app">Save</button></div>
    </div>
    <div class="card" id="defaults" data-async>
      ${skSlot()}
      <div class="hd"><h2>Defaults for new repositories</h2></div>
      <div class="bd">
        <div class="two" style="max-width:none">
          <div class="field"><label>Months of pull requests</label>
            <input id="def-months" value="${
      text(config.defaults?.maxPrMonths ?? "")
    }"></div>
          <div class="field"><label>Commits</label>
            <input id="def-commits" value="${
      text(config.defaults?.maxCommits ?? "")
    }"></div>
          <div class="field"><label>Max lines per pull request</label>
            <input id="def-lines" value="${
      text(config.defaults?.maxPullRequestChangeLines ?? "")
    }"></div>
        </div>
      </div>
      <div class="ft"><button class="primary" id="save-def">Save</button></div>
    </div>
    <div class="card" id="access">
      <div class="hd"><h2>Dashboard password</h2></div>
      <div class="bd">
        <p class="muted" style="margin:0">Set with <code>--password</code> when you start serve. It is printed to the console if you omit the flag.</p>
      </div>
    </div>
    <div class="card" id="about">
      <div class="hd"><h2>About</h2></div>
      <div class="bd">
        <table style="margin:-18px -18px 0;width:calc(100% + 36px)">
          <tbody>
            <tr><td style="width:200px" class="muted">Version</td>
              <td>${text(denoConfig.version)}</td></tr>
            <tr><td class="muted">Repository</td>
              <td><a href="${SOURCE_URL}">${
      text(SOURCE_URL.replace("https://", ""))
    }</a></td></tr>
            <tr><td class="muted">Developed by</td>
              <td>Murat Kirazkaya</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</div>
<script>
function save(btn, body) {
  run(btn, btn.closest("[data-async]"), async function() {
    await api("PUT", "/api/settings", body);
    location.reload();
  });
}
document.getElementById("save-ai").addEventListener("click", function() {
  save(this, {
    ai: document.getElementById("ai").value,
    token: document.getElementById("token").value,
    highModel: document.getElementById("high").value,
    lowModel: document.getElementById("low").value
  });
});
document.getElementById("save-gh").addEventListener("click", function() {
  save(this, {
    auth: document.getElementById("auth").value,
    githubPat: document.getElementById("pat").value
  });
});
document.getElementById("save-app").addEventListener("click", function() {
  save(this, {
    githubAppId: document.getElementById("app-id").value,
    githubAppPrivateKey: document.getElementById("app-key").value,
    githubWebhookSecret: document.getElementById("hook-secret").value
  });
});
document.getElementById("save-def").addEventListener("click", function() {
  var num = function(id) {
    var v = document.getElementById(id).value.trim();
    return v === "" ? null : Number(v);
  };
  save(this, {
    defaults: {
      maxPrMonths: num("def-months"),
      maxCommits: num("def-commits"),
      maxPullRequestChangeLines: num("def-lines")
    }
  });
});
</script>`,
  }));
}
