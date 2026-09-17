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
      <a href="#server">Server</a>
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
            <input id="webhook-url" value="${text(webhookUrl)}">
            <div class="hint">Public URL GitHub uses to send webhook events</div></div>
        </div>
        <div class="field wide"><label>Private key</label>
          <textarea id="app-key" class="mono pem" rows="8" spellcheck="false"
            autocomplete="off" autocapitalize="off"
            placeholder="-----BEGIN RSA PRIVATE KEY-----
...
-----END RSA PRIVATE KEY-----
Leave blank to keep the current key"></textarea></div>
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
    <div class="card" id="server" data-async>
      ${skSlot()}
      <div class="hd"><h2>Job queue</h2></div>
      <div class="bd">
        <div class="field"><label>Max concurrent jobs</label>
          <input id="max-jobs" value="${
      text(config.maxConcurrentJobs ?? "")
    }" placeholder="No limit">
          <div class="hint">Cap how many background jobs run at once across init, remake, and review. Leave blank for no limit.</div></div>
      </div>
      <div class="ft"><button class="primary" id="save-server">Save</button></div>
    </div>
    <div class="card" id="access" data-async>
      ${skSlot()}
      <div class="hd"><h2>Sign-in</h2></div>
      <div class="bd">
        <p class="muted" style="margin:0 0 16px">A <code>--disable-auth</code>/<code>--enable-auth</code> flag on <code>serve</code> overrides these for that run.</p>
        <div class="field wide"><label><input type="checkbox" id="password-auth"${
      config.passwordAuthDisabled ? "" : " checked"
    }> Password sign-in</label>
          <div class="hint">Set with <code>--password</code> when you start serve, or printed to the console if you omit the flag.</div></div>
        <div class="field wide"><label><input type="checkbox" id="github-auth"${
      config.githubAuthEnabled ? " checked" : ""
    }> GitHub sign-in</label></div>
        <div class="two" style="max-width:none">
          <div class="field"><label>OAuth client ID</label>
            <input id="oauth-client-id" value="${
      text(config.githubOAuthClientId ?? "")
    }"></div>
          <div class="field"><label>OAuth client secret</label>
            <input id="oauth-client-secret" type="password" placeholder="${
      config.githubOAuthClientSecret ? "Leave blank to keep the current secret" : ""
    }"></div>
        </div>
        <div class="field wide"><label>Allowed GitHub username</label>
          <input id="oauth-allowed-user" value="${
      text(config.githubOAuthAllowedUser ?? "")
    }">
          <div class="hint">Only this GitHub account can sign in through OAuth.</div></div>
      </div>
      <div class="ft"><button class="primary" id="save-access">Save</button></div>
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
    githubWebhookSecret: document.getElementById("hook-secret").value,
    webhookUrl: document.getElementById("webhook-url").value
  });
});
document.getElementById("save-access").addEventListener("click", function() {
  save(this, {
    passwordAuthDisabled: !document.getElementById("password-auth").checked,
    githubAuthEnabled: document.getElementById("github-auth").checked,
    githubOAuthClientId: document.getElementById("oauth-client-id").value,
    githubOAuthClientSecret: document.getElementById("oauth-client-secret").value,
    githubOAuthAllowedUser: document.getElementById("oauth-allowed-user").value
  });
});
document.getElementById("save-server").addEventListener("click", function() {
  var v = document.getElementById("max-jobs").value.trim();
  if (v === "") {
    save(this, { maxConcurrentJobs: null });
    return;
  }
  var n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    fail(
      this.closest("[data-async]"),
      "Enter a positive whole number, or leave blank for no limit.",
      function () {},
    );
    return;
  }
  save(this, { maxConcurrentJobs: n });
});
document.getElementById("save-def").addEventListener("click", function() {
  var card = this.closest("[data-async]");
  var positiveInt = function(id, label) {
    var v = document.getElementById(id).value.trim();
    if (v === "") return { ok: true, value: null };
    var n = Number(v);
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, message: label + " must be a positive whole number, or blank." };
    }
    return { ok: true, value: n };
  };
  var months = positiveInt("def-months", "Max PR age (months)");
  if (!months.ok) {
    fail(card, months.message, function () {});
    return;
  }
  var commits = positiveInt("def-commits", "Max commits");
  if (!commits.ok) {
    fail(card, commits.message, function () {});
    return;
  }
  var lines = positiveInt("def-lines", "Max changed lines");
  if (!lines.ok) {
    fail(card, lines.message, function () {});
    return;
  }
  save(this, {
    defaults: {
      maxPrMonths: months.value,
      maxCommits: commits.value,
      maxPullRequestChangeLines: lines.value
    }
  });
});
</script>`,
  }));
}
