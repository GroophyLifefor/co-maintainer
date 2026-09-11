function toast(message) {
  var host = document.getElementById("toasts");
  if (!host) return;
  var el = document.createElement("div");
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
  var box = card.querySelector("[data-fail]");
  if (!box) {
    box = document.createElement("div");
    box.setAttribute("data-fail", "1");
    box.className = "fail";
    card.appendChild(box);
  }
  box.replaceChildren();
  var p = document.createElement("p");
  p.textContent = message;
  var btn = document.createElement("button");
  btn.className = "btn sm";
  btn.type = "button";
  btn.textContent = "Retry";
  btn.addEventListener("click", retry);
  box.appendChild(p);
  box.appendChild(btn);
}

function clearFail(card) {
  var box = card && card.querySelector("[data-fail]");
  if (box) box.remove();
}

function skeleton(card, on) {
  if (!card) return;
  card.classList.toggle("busy", on);
}

async function api(method, url, body) {
  var res = await fetch(url, {
    method: method,
    headers: {
      "content-type": "application/json",
      "x-requested-with": "co-maintainer",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    var message = "Request failed";
    try {
      var data = await res.json();
      if (data.error && data.error.message) message = data.error.message;
    } catch (_) {}
    throw new Error(message);
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

async function postAndGo(url, body, next, btn) {
  var card = btn && btn.closest("[data-async]");
  await run(btn, card, async function () {
    await api("POST", url, body);
    location.href = next;
  });
}

function bindToggle(btn, url, field) {
  btn.addEventListener("click", async function () {
    if (btn.disabled) return;
    var on = !btn.classList.contains("on");
    btn.classList.toggle("on", on);
    btn.setAttribute("data-on", on ? "1" : "0");
    btn.disabled = true;
    var card = btn.closest("[data-async]");
    try {
      var payload = {};
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

window.onerror = function (_m, _s, _l, _c, err) {
  toast((err && err.message) || "Something broke");
};
window.addEventListener("unhandledrejection", function (ev) {
  toast((ev.reason && ev.reason.message) || "Something broke");
});

document.addEventListener("click", function (ev) {
  var btn = ev.target && ev.target.closest
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
  var body = btn.getAttribute("data-body");
  postAndGo(
    btn.getAttribute("data-post"),
    body ? JSON.parse(body) : {},
    "/activity",
    btn,
  );
});

(function pollActivity() {
  if (!document.getElementById("activity-root")) return;
  setInterval(async function () {
    if (document.hidden) return;
    if (document.querySelector("[data-async].busy")) return;
    var root = document.getElementById("activity-root");
    if (!root) return;
    try {
      var res = await fetch(location.pathname + location.search, {
        headers: { accept: "text/html" },
      });
      if (!res.ok) return;
      var doc = new DOMParser().parseFromString(await res.text(), "text/html");
      var next = doc.getElementById("activity-root");
      if (!next || next.innerHTML === root.innerHTML) return;
      root.replaceWith(next);
    } catch (_) {}
  }, 5000);
})();
