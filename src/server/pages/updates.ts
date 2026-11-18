/** The newer version notice in the sidebar and the Updates card on the
 * Server settings page. Both read `updateNotice`, which never waits on the
 * network. */
import { escapeHtml, text, when } from "./layout.ts";
import { alert, codeBlock } from "./ui.ts";
import type { UpdateNotice } from "../../services/update_check.ts";

const RELEASES = "https://github.com/GroophyLifefor/co-maintainer/releases";

/** The lines a self-hosted Docker server updates with. */
export const DOCKER_UPDATE = `docker pull ghcr.io/groophylifefor/co-maintainer:latest
docker stop co-maintainer
docker rm co-maintainer
docker run -d --name co-maintainer -p 5000:5000 \\
  -v co-maintainer-data:/data \\
  ghcr.io/groophylifefor/co-maintainer:latest`;

function outLine(notice: UpdateNotice): string {
  return `co-maintainer ${notice.latest} is out. This instance runs ${notice.running}.`;
}

export function updatesCard(notice: UpdateNotice): string {
  let body: string;
  if (!notice.canUpdate) {
    // No CM_UPDATE_URL: nothing calls out, so this server cannot know about
    // a newer release. It says how a self-hosted server updates instead.
    body = `<p>This server does not check for a newer version, so it never calls out. A host that sets <code>CM_UPDATE_URL</code> gets the check and an Update button.</p>
      <p>To update a self-hosted Docker server, pull the new image and start the container again on the same volume, with the options you started it with:</p>
      ${codeBlock({ code: DOCKER_UPDATE })}
      <p class="muted">Installed with npm: <code>npm install -g co-maintainer@latest</code>, then restart <code>serve</code>. See every release on <a href="${RELEASES}" target="_blank" rel="noopener">GitHub</a>.</p>`;
  } else if (notice.update?.status === "requested") {
    body = `${alert("sky", {
      title: `Updating to ${notice.update.target}`,
      body: `Asked ${when(notice.update.startedAt)}. The host restarts this instance on the new image. This page reloads when ${text(
        notice.update.target,
      )} runs.`,
      icon: "loader",
    })}<div data-update-wait="${escapeHtml(notice.update.target)}"></div>`;
  } else {
    const failed =
      notice.update?.status === "failed"
        ? alert("red", {
            title: `The update to ${notice.update.target} did not start`,
            body: text(
              notice.update.message ?? "The update endpoint refused it.",
            ),
          })
        : "";
    const checked = notice.checkedAt
      ? `Last checked ${when(notice.checkedAt)}.`
      : "The first check runs in the background now.";
    body = notice.latest
      ? `${failed}<p><b>${text(outLine(notice))}</b>${
          notice.notesUrl
            ? ` <a href="${escapeHtml(notice.notesUrl)}" target="_blank" rel="noopener">Release notes</a>`
            : ""
        }</p>
        <p class="muted">${checked} The host restarts this instance on the new image.</p>
        <button class="primary" type="button" id="start-update" data-version="${escapeHtml(
          notice.latest,
        )}">Update to ${text(notice.latest)}</button>`
      : `${failed}<p>This instance runs ${text(notice.running)}, the latest release we know of.</p>
        <p class="muted">${checked} The check runs at most once a day.</p>`;
  }
  return `<div class="card" id="updates" data-async>
      <div class="hd"><h2>Updates</h2></div>
      <div class="bd">${body}</div>
    </div>`;
}

/** Starts the update, then waits on `/api/health` until the new version
 * answers and reloads. */
export const UPDATES_SCRIPT = `
(function() {
  var start = document.getElementById("start-update");
  if (start) {
    start.addEventListener("click", function() {
      var btn = this;
      var version = btn.getAttribute("data-version");
      if (!confirm("Update this instance to " + version + "? It restarts on the new image.")) return;
      run(btn, btn.closest("[data-async]"), async function() {
        await api("POST", "/api/update", { version: version });
        location.reload();
      });
    });
  }
  var wait = document.querySelector("[data-update-wait]");
  if (!wait) return;
  var target = wait.getAttribute("data-update-wait");
  setInterval(async function() {
    try {
      var res = await fetch("/api/health", { cache: "no-store" });
      if (!res.ok) return;
      var body = await res.json();
      if (body.version === target) location.reload();
    } catch (_) {
      // the instance is restarting, try again on the next tick
    }
  }, 5000);
})();
`;
