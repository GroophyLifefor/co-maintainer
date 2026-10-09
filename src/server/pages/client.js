function toast(message) {
  const host = document.getElementById("toasts");
  if (!host) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.textContent = message;
  host.appendChild(el);
  setTimeout(function () {
    el.remove();
  }, 5000);
}

function fail(card, message, retry) {
  toast(message);
  if (!card) return;
  let box = card.querySelector("[data-fail]");
  if (!box) {
    box = document.createElement("div");
    box.setAttribute("data-fail", "1");
    box.className = "fail";
    card.appendChild(box);
  }
  box.replaceChildren();
  const p = document.createElement("p");
  p.textContent = message;
  const btn = document.createElement("button");
  btn.className = "btn sm";
  btn.type = "button";
  btn.textContent = "Retry";
  btn.addEventListener("click", retry);
  box.appendChild(p);
  box.appendChild(btn);
}

function clearFail(card) {
  const box = card && card.querySelector("[data-fail]");
  if (box) box.remove();
}

function skeleton(card, on) {
  if (!card) return;
  card.classList.toggle("busy", on);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method: method,
    headers: {
      "content-type": "application/json",
      "x-requested-with": "co-maintainer",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = "Request failed";
    let code = "";
    let detail;
    try {
      const data = await res.json();
      if (data.error && data.error.message) message = data.error.message;
      if (data.error && data.error.code) code = data.error.code;
      if (data.error) detail = data.error.detail;
    } catch {
      // body was not JSON; keep the generic message
    }
    const error = new Error(message);
    if (code) error.code = code;
    error.detail = detail;
    throw error;
  }
  if (res.status === 204) return null;
  return await res.json();
}

async function run(btn, card, fn) {
  if (btn) btn.disabled = true;
  skeleton(card, true);
  clearFail(card);
  try {
    await fn();
  } catch (err) {
    fail(card, err.message, function () {
      run(btn, card, fn);
    });
  } finally {
    if (btn) btn.disabled = false;
    skeleton(card, false);
  }
}

/** Polls one job until it reaches a terminal status. A running `init`/`remake`
 * ignores the abort signal, so "wait for the sync" is the only honest option
 * the clear pages can offer for it. */
function waitForJob(id) {
  return new Promise(function (resolve, reject) {
    let attempts = 0;
    async function tick() {
      attempts++;
      try {
        const res = await fetch("/api/jobs/" + encodeURIComponent(id), {
          headers: { "x-requested-with": "co-maintainer" },
        });
        if (!res.ok) throw new Error("Could not check the running job.");
        const job = await res.json();
        if (job.status !== "running" && job.status !== "queued") {
          resolve();
          return;
        }
        if (attempts > 1200) {
          reject(new Error("The sync did not finish."));
          return;
        }
        setTimeout(tick, 3000);
      } catch (err) {
        reject(err);
      }
    }
    tick();
  });
}

/** Clears knowledge, asking about pending jobs when the server refuses.
 * Returns false when the user backed out, so the caller does not reload.
 * A running review is abortable and a running setup is not, which is the
 * difference between the two questions. */
async function clearKnowledge(url, includeCache) {
  const target = includeCache ? url + "?includeCache=1" : url;
  const retry = target.indexOf("?") >= 0 ? "&" : "?";
  try {
    await api("DELETE", target);
  } catch (err) {
    if (err.code !== "jobs_running") throw err;
    const detail = err.detail || { queued: 0, running: [] };
    const running = detail.running || [];
    const setup = running.find(function (job) {
      return job.abortable === false;
    });
    if (setup) {
      if (
        !confirm(
          "A sync is running and cannot be stopped. Wait for it to finish and then clear?",
        )
      ) {
        return false;
      }
      await waitForJob(setup.id);
      await api("DELETE", target);
      return;
    }
    const parts = [];
    if (running.length) parts.push(running.length + " running review(s)");
    if (detail.queued) parts.push(detail.queued + " queued job(s)");
    if (!confirm("Stop " + parts.join(" and ") + " and clear?")) return false;
    try {
      await api("DELETE", target + retry + "onRunning=abort");
    } catch (retryError) {
      // A setup job was claimed between the first 409 and this retry. It
      // cannot be aborted, so wait it out like the branch above.
      if (retryError.code !== "job_not_abortable") throw retryError;
      const jobId = retryError.detail && retryError.detail.id;
      if (jobId) await waitForJob(jobId);
      await api("DELETE", target);
    }
  }
}

async function postAndGo(url, body, next, btn) {
  const card = btn && btn.closest("[data-async]");
  await run(btn, card, async function () {
    await api("POST", url, body);
    location.href = next;
  });
}

// Called from the inline scripts on the repo list and repo pages, which deno lint
// cannot see, so it looks unused from inside this file.
// deno-lint-ignore no-unused-vars
function bindToggle(btn, url, field) {
  btn.addEventListener("click", async function () {
    if (btn.disabled) return;
    const on = !btn.classList.contains("on");
    btn.classList.toggle("on", on);
    btn.setAttribute("data-on", on ? "1" : "0");
    btn.disabled = true;
    const card = btn.closest("[data-async]");
    try {
      const payload = {};
      payload[field] = on;
      await api("PATCH", url, payload);
    } catch (err) {
      btn.classList.toggle("on", !on);
      btn.setAttribute("data-on", on ? "0" : "1");
      fail(card, err.message, function () {
        btn.click();
      });
    } finally {
      btn.disabled = false;
    }
  });
}

// The helper is inlined into `<head>` by `layout.ts`, before any page script
// runs, so this is the one place that can close over both `toast()` and
// `bindToggle` without depending on point-in-time globals.
document.addEventListener("DOMContentLoaded", function () {
  // Client errors bubble to `window` from `document`.
  addEventListener("error", function (ev) {
    toast((ev.error && ev.error.message) || "Something broke");
  });
  addEventListener("unhandledrejection", function (ev) {
    toast((ev.reason && ev.reason.message) || "Something broke");
  });

  document.addEventListener("click", function (ev) {
    const btn =
      ev.target && ev.target.closest
        ? ev.target.closest("[data-cancel], [data-post]")
        : null;
    if (!btn) return;
    ev.preventDefault();
    if (btn.hasAttribute("data-cancel")) {
      postAndGo(
        "/api/jobs/" + btn.getAttribute("data-cancel") + "/cancel",
        {},
        "/activity",
        btn,
      );
      return;
    }
    const body = btn.getAttribute("data-body");
    postAndGo(
      btn.getAttribute("data-post"),
      body ? JSON.parse(body) : {},
      "/activity",
      btn,
    );
  });

  // Reads `activity-root` at call time, so it has to wait for the body even
  // though this file itself is already parsed.
  if (!document.getElementById("activity-root")) return;
  setInterval(async function () {
    if (document.hidden) return;
    if (document.querySelector("[data-async].busy")) return;
    const root = document.getElementById("activity-root");
    if (!root) return;
    try {
      const res = await fetch(location.pathname + location.search, {
        headers: { accept: "text/html" },
      });
      if (!res.ok) return;
      const doc = new DOMParser().parseFromString(
        await res.text(),
        "text/html",
      );
      const next = doc.getElementById("activity-root");
      if (!next || next.innerHTML === root.innerHTML) return;
      root.replaceWith(next);
    } catch {
      // a failed poll just waits for the next tick
    }
  }, 5000);
});
