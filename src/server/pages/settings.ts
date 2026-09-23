import { html, layout, skSlot, text } from "./layout.ts";
import type { UserConfig } from "../../config.ts";
import { VERSION } from "../../version.ts";

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
  return html(
    layout({
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
      <a href="#remote">Remote review</a>
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
            <option value="hetzner"${config.ai === "hetzner" ? " selected" : ""}>Hetzner</option>
          </select></div>
        <div class="field"><label>API key</label>
          <input id="token" type="password" placeholder="Leave blank to keep the current key">
          <div class="hint">${config.token ? "A key is saved" : "No key saved"}</div></div>
        <div class="two" style="max-width:none">
          <div class="field"><label>High model</label>
            <input id="high" value="${text(config.highModel ?? "")}">
            <div class="hint">Writes reviews and synthesizes the guides</div></div>
          <div class="field"><label>Low model</label>
            <input id="low" value="${text(config.lowModel ?? "")}">
            <div class="hint">Extracts facts from history during init and sync</div></div>
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
            <option value="gh"${config.auth !== "pat" ? " selected" : ""}>gh CLI</option>
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
            <input id="def-months" value="${text(config.defaults?.maxPrMonths ?? "")}"></div>
          <div class="field"><label>Commits</label>
            <input id="def-commits" value="${text(config.defaults?.maxCommits ?? "")}"></div>
          <div class="field"><label>Max lines per pull request</label>
            <input id="def-lines" value="${text(
              config.defaults?.maxPullRequestChangeLines ?? "",
            )}"></div>
        </div>
      </div>
      <div class="ft"><button class="primary" id="save-def">Save</button></div>
    </div>
    <div class="card" id="server" data-async>
      ${skSlot()}
      <div class="hd"><h2>Job queue</h2></div>
      <div class="bd">
        <div class="field"><label>Max concurrent jobs</label>
          <input id="max-jobs" value="${text(
            config.maxConcurrentJobs ?? "",
          )}" placeholder="No limit">
          <div class="hint">Cap how many background jobs run at once across init, sync, and review. Leave blank for no limit.</div></div>
        <div class="two" style="max-width:none;margin-top:16px">
          <div class="field"><label>Remote sync timeout (seconds)</label>
            <input id="remote-timeout" value="${text(
              config.remoteSyncTimeoutSeconds ?? "",
            )}" placeholder="10"></div>
          <div class="field"><label>Max remote reviews per token</label>
            <input id="remote-per-token" value="${text(
              config.maxConcurrentRemoteReviewsPerToken ?? "",
            )}" placeholder="No limit"></div>
          <div class="field"><label>Max tool output chars</label>
            <input id="remote-tool-chars" value="${text(
              config.remoteToolOutputMaxChars ?? "",
            )}" placeholder="500000"></div>
        </div>
      </div>
      <div class="ft"><button class="primary" id="save-server">Save</button></div>
    </div>
    <div class="card" id="remote" data-async>
      ${skSlot()}
      <div class="hd"><h2>Remote review tokens</h2></div>
      <div class="bd">
        <p class="muted" style="margin:0 0 16px">Bearer tokens for <code>co-maintainer review --remote</code>. The secret is shown once when created.</p>
        <div id="remote-token-secret" class="secret" hidden></div>
        <div id="remote-token-list" class="muted">Loading…</div>
        <div class="two" style="max-width:none;margin-top:16px">
          <div class="field"><label>New token name</label>
            <input id="remote-token-name" placeholder="e.g. laptop"></div>
        </div>
      </div>
      <div class="ft">
        <button class="primary" id="create-remote-token">Create token</button>
      </div>
    </div>
    <div class="card" id="access" data-async>
      ${skSlot()}
      <div class="hd"><h2>Sign-in</h2></div>
      <div class="bd">
        <p class="muted" style="margin:0 0 16px">A <code>--disable-auth</code>/<code>--enable-auth</code> flag on <code>serve</code> overrides these for that run.</p>
        <div class="field wide"><label><input type="checkbox" id="password-auth"${
          config.passwordAuthDisabled ? "" : " checked"
        }> Password sign-in</label>
          <div class="hint">The first start prints a generated password to the console. Change it in the Password card below.</div></div>
        <div class="field wide"><label><input type="checkbox" id="github-auth"${
          config.githubAuthEnabled ? " checked" : ""
        }> GitHub sign-in</label></div>
        <div class="two" style="max-width:none">
          <div class="field"><label>OAuth client ID</label>
            <input id="oauth-client-id" value="${text(config.githubOAuthClientId ?? "")}"></div>
          <div class="field"><label>OAuth client secret</label>
            <input id="oauth-client-secret" type="password" placeholder="${
              config.githubOAuthClientSecret
                ? "Leave blank to keep the current secret"
                : ""
            }"></div>
        </div>
        <div class="field wide"><label>Allowed GitHub username</label>
          <input id="oauth-allowed-user" value="${text(config.githubOAuthAllowedUser ?? "")}">
          <div class="hint">Only this GitHub account can sign in through OAuth.</div></div>
      </div>
      <div class="ft"><button class="primary" id="save-access">Save</button></div>
    </div>
    <div class="card" id="password" data-async>
      ${skSlot()}
      <div class="hd"><h2>Password</h2></div>
      <div class="bd">
        <p class="muted" style="margin:0 0 16px">Changing it signs out every other browser session.</p>
        <div class="field wide"><label>Current password</label>
          <input id="pw-current" type="password" autocomplete="current-password"></div>
        <div class="two" style="max-width:none">
          <div class="field"><label>New password</label>
            <input id="pw-new" type="password" autocomplete="new-password">
            <div class="hint">8 to 200 characters.</div></div>
          <div class="field"><label>Repeat new password</label>
            <input id="pw-repeat" type="password" autocomplete="new-password"></div>
        </div>
      </div>
      <div class="ft"><button class="primary" id="save-password">Change password</button></div>
    </div>
    <div class="card" id="about">
      <div class="hd"><h2>About</h2></div>
      <div class="bd">
        <table style="margin:-18px -18px 0;width:calc(100% + 36px)">
          <tbody>
            <tr><td style="width:200px" class="muted">Version</td>
              <td>${text(VERSION)}</td></tr>
            <tr><td class="muted">Repository</td>
              <td><a href="${SOURCE_URL}">${text(SOURCE_URL.replace("https://", ""))}</a></td></tr>
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
document.getElementById("save-password").addEventListener("click", function() {
  var btn = this;
  var card = btn.closest("[data-async]");
  var next = document.getElementById("pw-new").value;
  if (next !== document.getElementById("pw-repeat").value) {
    fail(card, "The two new passwords do not match.", function () {});
    return;
  }
  run(btn, card, async function() {
    await api("POST", "/api/settings/password", {
      currentPassword: document.getElementById("pw-current").value,
      newPassword: next
    });
    ["pw-current", "pw-new", "pw-repeat"].forEach(function(id) {
      document.getElementById(id).value = "";
    });
    toast("Password changed");
  });
});
function positiveOrNull(raw, label) {
  if (raw === "") return { ok: true, value: null };
  var n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, message: label + " must be a positive whole number, or blank." };
  }
  return { ok: true, value: n };
}
document.getElementById("save-server").addEventListener("click", function() {
  var card = this.closest("[data-async]");
  var jobs = positiveOrNull(document.getElementById("max-jobs").value.trim(), "Max concurrent jobs");
  if (!jobs.ok) { fail(card, jobs.message, function () {}); return; }
  var timeout = positiveOrNull(document.getElementById("remote-timeout").value.trim(), "Remote sync timeout");
  if (!timeout.ok) { fail(card, timeout.message, function () {}); return; }
  var perToken = positiveOrNull(document.getElementById("remote-per-token").value.trim(), "Max remote reviews per token");
  if (!perToken.ok) { fail(card, perToken.message, function () {}); return; }
  var toolChars = positiveOrNull(document.getElementById("remote-tool-chars").value.trim(), "Max tool output chars");
  if (!toolChars.ok) { fail(card, toolChars.message, function () {}); return; }
  save(this, {
    maxConcurrentJobs: jobs.value,
    remoteSyncTimeoutSeconds: timeout.value,
    maxConcurrentRemoteReviewsPerToken: perToken.value,
    remoteToolOutputMaxChars: toolChars.value
  });
});
function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
async function loadRemoteTokens() {
  var el = document.getElementById("remote-token-list");
  try {
    var rows = await api("GET", "/api/remote-tokens");
    if (!rows.length) {
      el.innerHTML = "<p>No tokens yet.</p>";
      return;
    }
    el.innerHTML = "<table><thead><tr><th>Name</th><th>Status</th><th class=\\"num\\">Reviews (30d)</th><th class=\\"num\\">Cost (30d)</th><th></th></tr></thead><tbody>" +
      rows.map(function(r) {
        return "<tr><td>" + escHtml(r.name) + "</td><td>" + (r.active ? "Active" : "Inactive") + "</td>" +
          "<td class=\\"num\\">" + r.reviews30d + "</td><td class=\\"num\\">" + r.cost30d + "</td>" +
          "<td><button type=\\"button\\" class=\\"btn sm\\" data-token-id=\\"" + escHtml(r.id) + "\\" data-active=\\"" + r.active + "\\">" +
          (r.active ? "Deactivate" : "Activate") + "</button> " +
          "<button type=\\"button\\" class=\\"btn sm\\" data-delete-token=\\"" + escHtml(r.id) + "\\">Delete</button></td></tr>";
      }).join("") + "</tbody></table>";
    el.querySelectorAll("[data-token-id]").forEach(function(btn) {
      btn.addEventListener("click", function() {
        var id = btn.getAttribute("data-token-id");
        var active = btn.getAttribute("data-active") === "true";
        run(btn, cardFor(btn), async function() {
          await api("PATCH", "/api/remote-tokens/" + id, { active: !active });
          await loadRemoteTokens();
        });
      });
    });
    el.querySelectorAll("[data-delete-token]").forEach(function(btn) {
      btn.addEventListener("click", function() {
        if (!confirm("Delete this token? In-flight remote reviews will be canceled.")) return;
        var id = btn.getAttribute("data-delete-token");
        run(btn, cardFor(btn), async function() {
          await api("DELETE", "/api/remote-tokens/" + id);
          await loadRemoteTokens();
        });
      });
    });
  } catch (e) {
    el.textContent = "Could not load tokens.";
  }
}
function cardFor(btn) { return btn.closest("[data-async]"); }
function showSecret(token) {
  var box = document.getElementById("remote-token-secret");
  box.hidden = false;
  box.replaceChildren();
  var title = document.createElement("b");
  title.textContent = "Copy this token now. It is not shown again.";
  var row = document.createElement("div");
  row.className = "secret-row";
  var code = document.createElement("code");
  code.textContent = token;
  var copy = document.createElement("button");
  copy.type = "button";
  copy.className = "btn sm";
  copy.textContent = "Copy";
  copy.addEventListener("click", async function() {
    try {
      await navigator.clipboard.writeText(token);
      copy.textContent = "Copied";
    } catch (err) {
      toast("Copy failed. Select the token and copy it by hand.");
    }
  });
  var dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "btn sm";
  dismiss.textContent = "I have saved it";
  dismiss.addEventListener("click", function() {
    box.hidden = true;
    box.replaceChildren();
  });
  row.appendChild(code);
  row.appendChild(copy);
  row.appendChild(dismiss);
  box.appendChild(title);
  box.appendChild(row);
}
loadRemoteTokens();
document.getElementById("create-remote-token").addEventListener("click", function() {
  var name = document.getElementById("remote-token-name").value.trim();
  if (!name) {
    fail(this.closest("[data-async]"), "Enter a name for the token.", function () {});
    return;
  }
  run(this, this.closest("[data-async]"), async function() {
    var created = await api("POST", "/api/remote-tokens", { name: name });
    showSecret(created.token);
    document.getElementById("remote-token-name").value = "";
    await loadRemoteTokens();
  });
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
    }),
  );
}
