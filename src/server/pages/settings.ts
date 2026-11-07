import { html, layout, skSlot, text } from "./layout.ts";
import type { UserConfig } from "../../config.ts";
import {
  aiConfigured,
  resolveAppPrivateKey,
  resolvedAiToken,
} from "../../config.ts";
import { VERSION } from "../../version.ts";
import { appDbDir } from "../../store/app_db.ts";
import { TEMPLATE_INFO } from "../../services/review_policy.ts";
import {
  defaultAppName,
  manifestBlockedReason,
} from "../../github/app_manifest.ts";

const SOURCE_URL = "https://github.com/GroophyLifefor/co-maintainer";

export type SettingsSection =
  | "ai"
  | "github"
  | "defaults"
  | "remote"
  | "server"
  | "sign-in"
  | "danger";

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  "ai",
  "github",
  "defaults",
  "remote",
  "server",
  "sign-in",
  "danger",
];

const HEADING: Record<SettingsSection, string> = {
  ai: "AI models",
  github: "GitHub",
  defaults: "Review defaults",
  remote: "Remote access",
  server: "Server",
  "sign-in": "Sign-in",
  danger: "Danger zone",
};

const NAV_HREF: Record<SettingsSection, string> = {
  ai: "/settings/ai",
  github: "/settings/github",
  defaults: "/settings/defaults",
  remote: "/settings/remote",
  server: "/settings/server",
  "sign-in": "/settings/sign-in",
  danger: "/settings/danger",
};

/** Which key the jobs will use. The environment wins over the saved key, the
 * same order `resolvedAiToken` follows, so the hint must check it first. */
function keyHint(config: UserConfig): string {
  const fromEnv = resolvedAiToken({ ai: config.ai });
  if (fromEnv && config.token) {
    return "Using the key from the server's environment, which overrides the saved key";
  }
  if (fromEnv) return "Using the key from the server's environment";
  return config.token ? "A key is saved" : "No key saved";
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname || "localhost";
  } catch {
    return "localhost";
  }
}

/** `sk-or-v1-••••••••428`: the provider prefix and the last three
 * characters, enough to tell keys apart without showing one. A key too short
 * to keep both safely shows only dots. */
function maskKey(key: string): string {
  const prefix = /^(?:[a-z0-9]+-){1,3}/i.exec(key)?.[0] ?? "";
  if (prefix.length > 10 || key.length < prefix.length + 12) return "••••••••";
  return `${prefix}••••••••${key.slice(-3)}`;
}

function aiCard(config: UserConfig): string {
  const aiOk = aiConfigured(config);
  return `<div class="card" id="ai" data-async>
      ${skSlot()}
      <div class="hd"><h2>Models and API key</h2>
        <span class="st ${aiOk ? "ok" : "warn"}" style="margin-left:auto">${
          aiOk ? "Configured" : "Not set"
        }</span></div>
      <div class="bd">
        <div class="field"><label for="ai-provider">Provider</label>
          <select id="ai-provider">
            <option value="none"${
              !config.ai || config.ai === "none" ? " selected" : ""
            }>None</option>
            <option value="openrouter"${
              config.ai === "openrouter" ? " selected" : ""
            }>OpenRouter</option>
            <option value="openai"${
              config.ai === "openai" ? " selected" : ""
            }>OpenAI</option>
            <option value="anthropic"${
              config.ai === "anthropic" ? " selected" : ""
            }>Anthropic</option>
            <option value="opencode-zen"${
              config.ai === "opencode-zen" ? " selected" : ""
            }>OpenCode Zen</option>
            <option value="opencode-go"${
              config.ai === "opencode-go" ? " selected" : ""
            }>OpenCode Go</option>
          </select>
        <div class="cli"><code>--ai=${text(config.ai ?? "none")}</code></div></div>
        <div class="field"><label for="token">API key</label>${
          config.token
            ? `<div class="actions-row"><span class="inp mono key-mask">${text(
                maskKey(config.token),
              )}</span><button type="button" class="btn gh sm" id="replace-key">Replace</button></div>`
            : ""
        }
          <input id="token" type="password" placeholder="${
            config.token ? "Paste the new key" : "Paste the API key"
          }"${config.token ? " hidden" : ""}>
          <div class="hint">${keyHint(config)}</div>
          <div class="cli"><code>--ai-key=…</code></div></div>
        <div class="two" style="max-width:none">
          <div class="field"><label for="high">Review model</label>
            <input id="high" value="${text(config.highModel ?? "")}">
            <div class="hint">Writes reviews and synthesizes the guides. High model in the CLI.</div>
            <div class="cli"><code>--high-model=…</code></div></div>
          <div class="field"><label for="low">Extraction model</label>
            <input id="low" value="${text(config.lowModel ?? "")}">
            <div class="hint">Extracts facts from history during init and sync. A cheap model is enough. Low model in the CLI.</div>
            <div class="cli"><code>--low-model=…</code></div></div>
        </div>
      </div>
      <div class="ft"><button class="primary" id="save-ai">Save</button></div>
    </div>`;
}

function githubCards(
  config: UserConfig,
  webhookUrl: string,
  host: string,
): string {
  const ghOk = Boolean(
    config.auth === "gh" || (config.auth === "pat" && config.githubPat),
  );
  const appOk = Boolean(config.githubAppId && resolveAppPrivateKey(config));
  const manifestBlock = manifestBlockedReason(webhookUrl);
  return `<div class="card" id="github" data-async>
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
          <input id="pat" type="password" placeholder="Leave blank to keep the current token">
          <div class="hint">Read-only is enough. <a href="https://co-maintainer.com/docs/authentication.html" target="_blank" rel="noopener">Which permissions to grant</a></div></div>
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
        <p class="muted" style="margin:0 0 16px">Needed to post reviews on pull requests. <a href="https://co-maintainer.com/docs/github-app.html#permissions" target="_blank" rel="noopener">Permissions it needs</a></p>
        <div style="margin:0 0 16px">
          <div class="two" style="max-width:none;margin:0 0 12px">
            <div class="field"><label>App name</label>
              <input id="app-name" value="${text(defaultAppName(host))}">
              <div class="hint">Must be unique on GitHub. Editable.</div></div>
          </div>
          <button class="btn" id="create-app">Create GitHub App</button>
          <div class="hint" style="margin:6px 0 0">${
            manifestBlock
              ? `${text(manifestBlock)}`
              : "Opens GitHub, then fills App ID, private key, webhook secret, and OAuth below for you."
          }</div>
        </div>
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
    <div class="card" id="slack" data-async>
      ${skSlot()}
      <div class="hd"><h2>Slack</h2>
        <span class="st ${config.slackWebhookUrl ? "ok" : "warn"}" style="margin-left:auto">${
          config.slackWebhookUrl ? "Configured" : "Not set"
        }</span></div>
      <div class="bd">
        <p class="muted" style="margin:0 0 16px">Posts one line to a channel after every review: the pull request, the number of findings and how long it took.</p>
        <div class="field wide"><label>Incoming webhook URL</label>
          <input id="slack-url" type="password" placeholder="${
            config.slackWebhookUrl
              ? "Leave blank to keep the current URL"
              : "https://hooks.slack.com/services/..."
          }">
          <div class="hint"><a href="https://api.slack.com/messaging/webhooks" target="_blank" rel="noopener">Create an incoming webhook</a></div></div>
      </div>
      <div class="ft">
        <button class="btn" id="test-slack">Send test</button>
        <button class="primary" id="save-slack">Save</button>
      </div>
    </div>`;
}

function defaultsCard(config: UserConfig): string {
  return `<div class="card" id="defaults" data-async>
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
        <div class="field wide" style="margin-top:18px">
          <label for="def-policy">Who gets a review</label>
          <select id="def-policy">
            <option value=""${config.reviewPolicy === undefined ? " selected" : ""}>Everyone except drafts and bots (the simple switches)</option>
            ${TEMPLATE_INFO.map(
              (item) =>
                `<option value="${text(item.name)}"${config.reviewPolicy === item.name ? " selected" : ""}>${text(item.label)}</option>`,
            ).join("")}
            ${
              typeof config.reviewPolicy === "object"
                ? `<option value="__custom" selected>Custom rules from a file</option>`
                : ""
            }
          </select>
          <div class="hint" id="def-policy-desc">${text(
            typeof config.reviewPolicy === "string"
              ? (TEMPLATE_INFO.find((item) => item.name === config.reviewPolicy)
                  ?.description ?? "")
              : "",
          )}</div>
          <div class="hint">New repositories start with this. Each repository can change it in its own settings. Custom rules are set with <span class="mono">co-maintainer set --review-policy-file=policy.json</span>.</div>
        </div>
      </div>
      <div class="ft"><button class="primary" id="save-def">Save</button></div>
    </div>`;
}

export type RuntimeInfo = {
  port?: number;
  trustProxy?: boolean;
};

function runtimeCard(runtime: RuntimeInfo): string {
  const port = runtime.port === undefined ? "unknown" : String(runtime.port);
  return `<div class="card" id="runtime">
      <div class="hd"><h2>This server</h2></div>
      <div class="bd">
        <dl class="dl">
          <div><dt>Version</dt><dd>${text(VERSION)}</dd></div>
          <div><dt>Port</dt><dd>${text(port)}</dd></div>
          <div><dt>Behind a proxy</dt><dd>${runtime.trustProxy ? "Yes" : "No"}</dd></div>
          <div><dt>Data</dt><dd class="mono">${text(appDbDir())}</dd></div>
        </dl>
      </div>
    </div>`;
}

function serverCard(config: UserConfig, runtime: RuntimeInfo): string {
  return `${runtimeCard(runtime)}<div class="card" id="server" data-async>
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
    </div>`;
}

function remoteCard(config: UserConfig): string {
  return `<div class="card" id="remote" data-async>
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
        <div class="field wide" style="margin-top:16px"><label>Client key policy (BYOK)</label>
          <select id="remote-byok-policy">
            <option value="off"${
              (config.remoteByokPolicy ?? "off") === "off" ? " selected" : ""
            }>off: reject a client key</option>
            <option value="allow"${
              config.remoteByokPolicy === "allow" ? " selected" : ""
            }>allow: accept a client key, fall back to the server key</option>
            <option value="require"${
              config.remoteByokPolicy === "require" ? " selected" : ""
            }>require: a client key is mandatory</option>
          </select>
          <div class="hint">Whether <code>review --remote</code> clients may send their own AI key. The <code>CM_REMOTE_BYOK_POLICY</code> env var overrides this.</div></div>
      </div>
      <div class="ft">
        <button class="primary" id="create-remote-token">Create token</button>
        <button class="btn" id="save-remote-byok">Save policy</button>
      </div>
    </div>`;
}

function signInCards(config: UserConfig): string {
  return `<div class="card" id="access" data-async>
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
    </div>`;
}

function dangerCard(): string {
  return `<div class="card" id="danger" data-async>
      ${skSlot()}
      <div class="hd"><h2>Clear all knowledge</h2></div>
      <div class="bd">
        <p class="muted" style="margin:0 0 16px">Delete every repository's guides and saved settings on this server. Repository records, reviews and tokens stay, so this is not an uninstall.</p>
        <div class="field wide"><label><input type="checkbox" id="clear-all-cache"> Also delete the cached evidence: pull request listings, costs, clones and worktrees</label></div>
      </div>
      <div class="ft"><button id="clear-all" style="color:var(--red)">Clear all knowledge</button></div>
    </div>`;
}

function aboutCard(): string {
  return `<div class="card" id="about">
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
    </div>`;
}

function cardForSection(
  section: SettingsSection,
  config: UserConfig,
  webhookUrl: string,
  host: string,
  runtime: RuntimeInfo,
): string {
  switch (section) {
    case "ai":
      return aiCard(config);
    case "github":
      return githubCards(config, webhookUrl, host);
    case "defaults":
      return defaultsCard(config);
    case "remote":
      return remoteCard(config);
    case "server":
      return serverCard(config, runtime);
    case "sign-in":
      return signInCards(config);
    case "danger":
      return dangerCard();
  }
}

/** The helpers shared by every settings script, so a page only needs the block
 * for its own card. Kept in one place rather than copied per page. */
const SCRIPT_COMMON = `
function save(btn, body) {
  var card = btn.closest("[data-async]");
  run(btn, card, async function() {
    await api("PUT", "/api/settings", body);
    saved(btn, card);
  });
}
function positiveOrNull(raw, label) {
  if (raw === "") return { ok: true, value: null };
  var n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, message: label + " must be a positive whole number, or blank." };
  }
  return { ok: true, value: n };
}
function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
async function loadRemoteTokens() {
  var el = document.getElementById("remote-token-list");
  if (!el) return;
  try {
    var rows = await api("GET", "/api/remote-tokens");
    if (!rows.length) {
      el.innerHTML = "<p>No tokens yet.</p>";
      return;
    }
    el.innerHTML = "<table><thead><tr><th>Name</th><th>Status</th><th class=\\"num\\">Reviews (30d)</th><th class=\\"num\\">Cost (30d)</th><th></th></tr></thead><tbody>" +
      rows.map(function(r) {
        return "<tr><td>" + escHtml(r.name) + "</td><td>" + (r.active ? "Active" : "Inactive") + "</td>" +
          "<td class=\\"num\\">" + r.reviews30d + "</td><td class=\\"num\\">" + escHtml(r.cost30dLabel) + "</td>" +
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
`;

const SCRIPT_AI = `
var replaceKey = document.getElementById("replace-key");
if (replaceKey) replaceKey.addEventListener("click", function() {
  var input = document.getElementById("token");
  input.hidden = false;
  input.focus();
  replaceKey.closest(".actions-row").hidden = true;
});
document.getElementById("save-ai").addEventListener("click", function() {
  save(this, {
    ai: document.getElementById("ai-provider").value,
    token: document.getElementById("token").value,
    highModel: document.getElementById("high").value,
    lowModel: document.getElementById("low").value
  });
});
`;

const SCRIPT_GITHUB = `
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
document.getElementById("save-slack").addEventListener("click", function() {
  save(this, {
    slackWebhookUrl: document.getElementById("slack-url").value.trim()
  });
});
document.getElementById("test-slack").addEventListener("click", function() {
  var btn = this;
  var card = cardFor(btn);
  run(btn, card, async function() {
    await api("POST", "/api/slack/test", {
      webhookUrl: document.getElementById("slack-url").value.trim()
    });
    toast("Test message sent to Slack.");
  });
});
document.getElementById("create-app").addEventListener("click", function() {
  var card = this.closest("[data-async]");
  var name = document.getElementById("app-name").value.trim();
  if (!name) {
    fail(card, "Enter a name for the GitHub App.", function () {});
    return;
  }
  var form = document.createElement("form");
  form.method = "POST";
  form.action = "/github/app-manifest";
  form.style.display = "none";
  var field = document.createElement("input");
  field.type = "hidden";
  field.name = "name";
  field.value = name;
  form.appendChild(field);
  document.body.appendChild(form);
  form.submit();
});
`;

const SCRIPT_DEFAULTS = `
var POLICY_INFO = ${JSON.stringify(TEMPLATE_INFO)};
document.getElementById("def-policy").addEventListener("change", function() {
  var value = this.value;
  var text = "";
  POLICY_INFO.forEach(function(item) { if (item.name === value) text = item.description; });
  document.getElementById("def-policy-desc").textContent = text;
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
  var body = {
    defaults: {
      maxPrMonths: months.value,
      maxCommits: commits.value,
      maxPullRequestChangeLines: lines.value
    }
  };
  var policy = document.getElementById("def-policy").value;
  if (policy !== "__custom") body.reviewPolicy = policy === "" ? null : policy;
  save(this, body);
});
`;

const SCRIPT_SERVER = `
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
`;

const SCRIPT_REMOTE = `
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
document.getElementById("save-remote-byok").addEventListener("click", function() {
  save(this, {
    remoteByokPolicy: document.getElementById("remote-byok-policy").value
  });
});
`;

const SCRIPT_SIGNIN = `
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
`;

const SCRIPT_DANGER = `
document.getElementById("clear-all").addEventListener("click", function() {
  if (!confirm("Delete the guides and saved settings for every repository on this server?")) return;
  var includeCache = document.getElementById("clear-all-cache").checked;
  var btn = this;
  run(btn, btn.closest("[data-async]"), async function() {
    var done = await clearKnowledge("/api/knowledge", includeCache);
    if (done !== false) location.reload();
  });
});
`;

const SCRIPT_BY_SECTION: Record<SettingsSection, string> = {
  ai: SCRIPT_AI,
  github: SCRIPT_GITHUB,
  defaults: SCRIPT_DEFAULTS,
  remote: SCRIPT_REMOTE,
  server: SCRIPT_SERVER,
  "sign-in": SCRIPT_SIGNIN,
  danger: SCRIPT_DANGER,
};

/** The combined `/settings` landing keeps every card (and the old bookmarks
 * working) while each heading also has its own page. */
export function renderSettings(
  username: string,
  config: UserConfig,
  webhookUrl: string,
  baseUrl: string,
  runtime: RuntimeInfo = {},
): Response {
  return settingsPage(
    username,
    config,
    webhookUrl,
    baseUrl,
    SETTINGS_SECTIONS,
    "AI models",
    "Settings · co-maintainer",
    NAV_HREF.ai,
    true,
    runtime,
  );
}

export function renderSettingsPage(
  username: string,
  config: UserConfig,
  webhookUrl: string,
  baseUrl: string,
  section: SettingsSection,
  runtime: RuntimeInfo = {},
): Response | undefined {
  if (!SETTINGS_SECTIONS.includes(section)) return undefined;
  return settingsPage(
    username,
    config,
    webhookUrl,
    baseUrl,
    [section],
    HEADING[section],
    `${HEADING[section]} · co-maintainer`,
    NAV_HREF[section],
    false,
    runtime,
  );
}

function settingsPage(
  username: string,
  config: UserConfig,
  webhookUrl: string,
  baseUrl: string,
  sections: readonly SettingsSection[],
  heading: string,
  title: string,
  active: string,
  combined: boolean,
  runtime: RuntimeInfo,
): Response {
  const host = hostOf(baseUrl);
  const cards = sections
    .map((section) =>
      cardForSection(section, config, webhookUrl, host, runtime),
    )
    .join("");
  const about = sections.includes("server") || combined ? aboutCard() : "";
  const fragment = combined
    ? `
(function() {
  var map = {
    ai: "/settings/ai", github: "/settings/github", defaults: "/settings/defaults",
    remote: "/settings/remote", server: "/settings/server",
    access: "/settings/sign-in", signin: "/settings/sign-in", password: "/settings/sign-in",
    danger: "/settings/danger"
  };
  var id = location.hash.replace(/^#/, "").toLowerCase();
  if (map[id]) location.replace(map[id]);
})();`
    : "";
  const script =
    SCRIPT_COMMON +
    sections.map((section) => SCRIPT_BY_SECTION[section]).join("") +
    fragment;
  return html(
    layout({
      title,
      username,
      active,
      body: `<div class="wrap">
  <div class="pagehead"><div><h1>${text(heading)}</h1>
    <p class="lead">Used by every repository unless it overrides them.</p></div></div>
  ${cards}
  ${about}
</div>
<script>${script}</script>`,
    }),
  );
}
