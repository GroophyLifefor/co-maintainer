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

/** Copy text for the `codeBlock` copy button. `navigator.clipboard` needs a
 * secure context, so the hidden-textarea path keeps Copy working on plain
 * http://localhost too. `done` runs only when one of the two paths worked. */
function copyText(value, done, failed) {
  function fallback() {
    if (legacyCopy(value)) done();
    else if (failed) failed();
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value).then(done, fallback);
    return;
  }
  fallback();
}

function legacyCopy(value) {
  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy") === true;
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
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

function saved(btn, card) {
  if (card) {
    let state = card.querySelector(".save-state");
    if (!state) {
      state = document.createElement("span");
      state.className = "save-state";
      state.setAttribute("role", "status");
      if (btn && btn.parentNode) {
        btn.parentNode.insertBefore(state, btn.nextSibling);
      }
    }
    state.textContent = "Saved";
  }
  toast("Saved");
}
globalThis.saved = saved;

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
 * difference between the two questions. Called from the inline scripts on the
 * knowledge pages, so it looks unused from inside this file. */
// oxlint-disable-next-line no-unused-vars
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
// oxlint-disable-next-line no-unused-vars
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

function logLevelClass(level) {
  return ["info", "dim", "ok", "warn", "error"].indexOf(level) >= 0
    ? level
    : "info";
}

function logClock(at) {
  const date = new Date(at);
  if (isNaN(date.getTime())) return "--:--:--";
  return date.toTimeString().slice(0, 8);
}

/** One append-only log panel. The rendered lines are the starting point, the
 * SSE stream resumes after their last seq, and a slow poll catches lines
 * written by another process (the CLI or a direct database write). */
function startLogPanel(panel) {
  if (panel.getAttribute("data-started") === "1") return;
  panel.setAttribute("data-started", "1");
  const log = panel.querySelector(".log");
  if (!log) return;
  const jump = panel.querySelector("[data-log-jump]");
  const jumpN = jump && jump.querySelector("span");
  const count = panel.querySelector(".cnt");
  const pause = panel.querySelector("[data-log-pause]");
  const clear = panel.querySelector("[data-log-clear]");
  const status = panel.querySelector(".st");
  const errorBox = panel.querySelector("[data-log-error]");
  const id = panel.getAttribute("data-job") || panel.getAttribute("data-log");
  let live = panel.getAttribute("data-live") === "1";
  let baseStatus = live
    ? "Running"
    : panel.getAttribute("data-status") || "Done";
  let baseClass = live
    ? "run"
    : baseStatus === "Failed"
      ? "failed"
      : baseStatus === "Not posted" || baseStatus === "Canceled"
        ? "warn"
        : "done";
  let lines = log.querySelectorAll(".line").length;
  let empty = log.querySelector(".log-empty");
  let pending = 0;
  let paused = false;
  let buffered = [];
  let lastSeq = Number(panel.getAttribute("data-seq") || 0);
  if (!isFinite(lastSeq)) lastSeq = 0;
  const timers = [];
  let stream = null;

  function showEmpty() {
    if (empty) return;
    empty = document.createElement("p");
    empty.className = "log-empty";
    empty.textContent =
      "No log lines yet. New lines appear here as the job runs.";
    log.appendChild(empty);
  }

  function hideEmpty() {
    if (!empty) return;
    empty.remove();
    empty = null;
  }

  function setError(message) {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function clearError() {
    if (!errorBox) return;
    errorBox.textContent = "";
    errorBox.hidden = true;
  }

  function atBottom() {
    return log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
  }

  function setCount() {
    if (!count) return;
    count.textContent = lines + (lines === 1 ? " line" : " lines");
  }

  function setJump() {
    if (!jump) return;
    if (pending > 0) {
      if (jumpN) jumpN.textContent = "(" + pending + ")";
      jump.hidden = false;
    } else {
      if (jumpN) jumpN.textContent = "";
      jump.hidden = true;
    }
  }

  function add(line) {
    if (!line || typeof line.seq !== "number" || line.seq <= lastSeq) return;
    const wasAtBottom = atBottom();
    const el = document.createElement("div");
    el.className = "line lv-" + logLevelClass(line.level);
    el.setAttribute("data-seq", String(line.seq));
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = logClock(line.at);
    const m = document.createElement("span");
    m.className = "msg";
    m.textContent = String(line.message || "");
    el.appendChild(t);
    el.appendChild(m);
    log.appendChild(el);
    lines += 1;
    lastSeq = line.seq;
    hideEmpty();
    clearError();
    setCount();
    if (wasAtBottom) {
      log.scrollTop = log.scrollHeight;
      pending = 0;
      setJump();
    } else {
      pending += 1;
      setJump();
    }
  }

  function receive(line) {
    if (!line || typeof line.seq !== "number" || line.seq <= lastSeq) return;
    if (paused) {
      for (let index = 0; index < buffered.length; index++) {
        if (buffered[index].seq === line.seq) return;
      }
      buffered.push(line);
      return;
    }
    add(line);
  }

  function flush() {
    buffered.sort(function (a, b) {
      return a.seq - b.seq;
    });
    for (let index = 0; index < buffered.length; index++) add(buffered[index]);
    buffered = [];
  }

  function stopLive() {
    if (stream) {
      const current = stream;
      stream = null;
      try {
        current.abort();
      } catch {
        // the stream was already closed
      }
    }
    for (let index = 0; index < timers.length; index++) {
      clearInterval(timers[index]);
    }
    timers.length = 0;
  }

  function setLiveStatus(next) {
    live = false;
    panel.setAttribute("data-live", "0");
    baseStatus =
      next === "failed" ? "Failed" : next === "canceled" ? "Canceled" : "Done";
    baseClass =
      next === "failed" ? "failed" : next === "canceled" ? "warn" : "done";
    panel.setAttribute("data-status", baseStatus);
    if (!paused && status) {
      status.className = "st " + baseClass;
      status.textContent = baseStatus;
    }
    clearError();
    stopLive();
  }

  function poll() {
    if (!id) return;
    fetch("/api/jobs/" + encodeURIComponent(id), {
      headers: { "x-requested-with": "co-maintainer" },
    })
      .then(function (res) {
        if (!res.ok) throw new Error("could not poll the job log");
        return res.json();
      })
      .then(function (job) {
        if (!job) return;
        clearError();
        (job.logs || []).forEach(receive);
        if (job.status !== "running" && job.status !== "queued") {
          setLiveStatus(job.status);
        }
      })
      .catch(function () {
        if (live) setError("Log connection lost. Reconnecting...");
      });
  }

  function connect() {
    if (!id || typeof fetch !== "function") return;
    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    stream = controller;
    fetch(
      "/api/jobs/" +
        encodeURIComponent(id) +
        "/logs/stream?from=" +
        encodeURIComponent(String(lastSeq)),
      {
        headers: {
          accept: "text/event-stream",
          "x-requested-with": "co-maintainer",
        },
        signal: controller ? controller.signal : undefined,
      },
    )
      .then(function (res) {
        if (!res.ok || !res.body || typeof res.body.getReader !== "function") {
          setError("Log connection lost. Reconnecting...");
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        function pump() {
          return reader.read().then(function (chunk) {
            if (chunk.done) return;
            buffer += decoder.decode(chunk.value, { stream: true });
            const frames = buffer.split("\n\n");
            buffer = frames.pop() || "";
            frames.forEach(function (frame) {
              const data = [];
              frame.split("\n").forEach(function (line) {
                if (line.indexOf("data:") === 0) {
                  data.push(line.slice(5).replace(/^ /, ""));
                }
              });
              if (!data.length) return;
              try {
                receive(JSON.parse(data.join("\n")));
              } catch {
                // a malformed frame is skipped, not fatal
              }
            });
            return pump();
          });
        }
        return pump();
      })
      .catch(function () {
        if (stream === controller) {
          setError("Log connection lost. Reconnecting...");
        }
      });
  }

  if (jump) {
    jump.addEventListener("click", function () {
      log.scrollTop = log.scrollHeight;
      pending = 0;
      setJump();
    });
  }
  log.addEventListener("scroll", function () {
    if (atBottom()) {
      pending = 0;
      setJump();
    }
  });
  if (pause) {
    pause.addEventListener("click", function () {
      paused = !paused;
      pause.textContent = paused ? "Resume" : "Pause";
      if (status) {
        status.className = "st " + (paused ? "paused" : baseClass);
        status.textContent = paused ? "Paused" : baseStatus;
      }
      if (!paused) flush();
    });
  }
  if (clear) {
    clear.addEventListener("click", function () {
      for (let index = 0; index < buffered.length; index++) {
        if (buffered[index].seq > lastSeq) lastSeq = buffered[index].seq;
      }
      log.replaceChildren();
      lines = 0;
      pending = 0;
      buffered = [];
      showEmpty();
      setCount();
      setJump();
    });
  }
  setCount();
  setJump();
  if (live) {
    connect();
    timers.push(setInterval(poll, 1000));
  }
}

/** The Ctrl K palette. Every query gets a sequence number and only the
 * newest answer is drawn, so a slow reply to an older query never replaces
 * the results of the newer one. The highlighted row is the one Enter opens. */
function startPalette() {
  const pal = document.getElementById("pal");
  const overlay = document.getElementById("pal-ov");
  const input = document.getElementById("pal-q");
  const list = document.getElementById("pal-list");
  if (!pal || !overlay || !input || !list) return;
  let returnFocus = null;
  let seq = 0;
  let timer = 0;
  let index = 0;

  function items() {
    return list.querySelectorAll("[data-href]");
  }
  function highlight(next) {
    const rows = items();
    if (rows.length === 0) return;
    index = (next + rows.length) % rows.length;
    rows.forEach(function (row, i) {
      row.classList.toggle("on", i === index);
      row.setAttribute("aria-selected", i === index ? "true" : "false");
    });
    input.setAttribute("aria-activedescendant", rows[index].id);
    rows[index].scrollIntoView({ block: "nearest" });
  }
  function draw(result) {
    list.textContent = "";
    if (result.groups.length === 0) {
      const empty = document.createElement("div");
      empty.className = "none";
      empty.textContent = "No results";
      list.appendChild(empty);
      input.removeAttribute("aria-activedescendant");
      return;
    }
    let n = 0;
    result.groups.forEach(function (group) {
      const label = document.createElement("div");
      label.className = "gl";
      label.textContent = group.label;
      list.appendChild(label);
      group.items.forEach(function (item) {
        const row = document.createElement("a");
        row.className = "it";
        row.id = "pal-it-" + n++;
        row.href = item.href;
        row.setAttribute("data-href", item.href);
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", "false");
        const name = document.createElement("span");
        name.className = "lbl";
        name.textContent = item.label;
        row.innerHTML =
          '<svg class="ic" aria-hidden="true"><use href="#i-' +
          String(item.icon).replace(/[^a-z0-9-]/g, "") +
          '"></use></svg>';
        row.appendChild(name);
        list.appendChild(row);
      });
    });
    highlight(0);
  }
  async function search() {
    const mine = ++seq;
    pal.setAttribute("data-loading", "");
    try {
      const res = await fetch(
        "/api/search?q=" + encodeURIComponent(input.value),
        { headers: { "x-requested-with": "co-maintainer" } },
      );
      const result = await res.json();
      if (mine !== seq) return;
      draw(res.ok ? result : { groups: [] });
    } catch {
      if (mine === seq) draw({ groups: [] });
    } finally {
      if (mine === seq) pal.removeAttribute("data-loading");
    }
  }
  function open() {
    if (!pal.hidden) return;
    returnFocus = document.activeElement;
    pal.hidden = false;
    overlay.hidden = false;
    input.value = "";
    input.focus();
    search();
  }
  function close() {
    if (pal.hidden) return;
    pal.hidden = true;
    overlay.hidden = true;
    seq++;
    pal.removeAttribute("data-loading");
    if (returnFocus && returnFocus.focus) returnFocus.focus();
  }

  document.addEventListener("click", function (ev) {
    if (ev.target && ev.target.closest && ev.target.closest("[data-palette]")) {
      ev.preventDefault();
      open();
    }
  });
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      if (pal.hidden) open();
      else close();
      return;
    }
    if (pal.hidden) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    } else if (ev.key === "ArrowDown") {
      ev.preventDefault();
      highlight(index + 1);
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      highlight(index - 1);
    } else if (ev.key === "Enter" && ev.target === input) {
      const row = items()[index];
      if (row && !pal.hasAttribute("data-loading")) {
        ev.preventDefault();
        location.href = row.getAttribute("data-href");
      }
    }
  });
  input.addEventListener("input", function () {
    clearTimeout(timer);
    pal.setAttribute("data-loading", "");
    timer = setTimeout(search, 120);
  });
}

function startLogPanels() {
  const panels = document.querySelectorAll("[data-log]");
  for (let index = 0; index < panels.length; index++) {
    startLogPanel(panels[index]);
  }
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

  // Theme: the head bootstrap already applied the remembered choice; this only
  // flips it and stores the new one.
  const themeButton = document.getElementById("theme");
  if (themeButton) {
    themeButton.addEventListener("click", function () {
      const dark = document.documentElement.classList.toggle("dark");
      try {
        localStorage.setItem("theme", dark ? "dark" : "light");
      } catch {
        // storage may be unavailable; the class still applies for this page
      }
    });
  }

  // Mobile drawer. `open` on the aside slides it in; the overlay closes it and
  // choosing a link closes it before navigating.
  const drawer = document.querySelector("aside.side");
  const overlay = document.getElementById("overlay");
  const menuButton = document.getElementById("menu");
  function setDrawer(open) {
    if (drawer) drawer.classList.toggle("open", open);
    if (overlay) overlay.classList.toggle("on", open);
  }
  if (menuButton) {
    menuButton.addEventListener("click", function () {
      setDrawer(!(drawer && drawer.classList.contains("open")));
    });
  }
  if (overlay) {
    overlay.addEventListener("click", function () {
      setDrawer(false);
    });
  }
  if (drawer) {
    drawer.addEventListener("click", function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest("a")) {
        setDrawer(false);
      }
    });
  }

  startPalette();

  document.addEventListener("click", function (ev) {
    const btn =
      ev.target && ev.target.closest ? ev.target.closest("[data-copy]") : null;
    if (!btn) return;
    const box = btn.closest(".code");
    const span = box && box.querySelector("span:not(.lbl)");
    if (!span) return;
    ev.preventDefault();
    copyText(
      span.textContent || "",
      function () {
        toast("Copied");
      },
      function () {
        toast("Copy failed. Select the text and copy it by hand.");
      },
    );
  });

  document.addEventListener("click", function (ev) {
    const btn =
      ev.target && ev.target.closest
        ? ev.target.closest("[data-copy-doc]")
        : null;
    if (!btn) return;
    ev.preventDefault();
    const id = btn.getAttribute("data-copy-doc");
    const sources = document.querySelectorAll("[data-doc-source]");
    let source = null;
    for (let index = 0; index < sources.length; index++) {
      if (sources[index].getAttribute("data-doc-source") === id) {
        source = sources[index];
        break;
      }
    }
    if (!source) return;
    copyText(
      source.textContent || "",
      function () {
        toast("Copied");
      },
      function () {
        toast("Copy failed. Select the text and copy it by hand.");
      },
    );
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
  startLogPanels();
  if (!document.getElementById("activity-root")) return;
  const jobPanel = document.querySelector("[data-log]");
  if (jobPanel) {
    if (jobPanel.getAttribute("data-live") !== "1") return;
    const progress = document.querySelector("[data-job-progress]");
    if (!progress) return;
    const refreshError = document.querySelector("[data-job-refresh-error]");
    let refreshing = false;
    const refreshJob = async function () {
      if (document.hidden || refreshing) return;
      refreshing = true;
      try {
        const res = await fetch(location.pathname + location.search, {
          headers: { accept: "text/html" },
          cache: "no-store",
        });
        if (!res.ok) throw new Error("refresh failed");
        const doc = new DOMParser().parseFromString(
          await res.text(),
          "text/html",
        );
        const next = doc.querySelector("[data-job-progress]");
        if (next) progress.innerHTML = next.innerHTML;
        if (refreshError) {
          refreshError.textContent = "";
          refreshError.hidden = true;
        }
      } catch {
        if (refreshError) {
          refreshError.textContent =
            "Connection lost. Could not refresh this job. Reconnecting...";
          refreshError.hidden = false;
        }
      } finally {
        refreshing = false;
      }
    };
    setInterval(refreshJob, 2000);
    return;
  }
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
