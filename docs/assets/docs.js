(function () {
  var toggle = document.querySelector(".sidebar-toggle");
  var sidebar = document.getElementById("sidebar");
  if (toggle && sidebar) {
    function mq() {
      var mobile = window.matchMedia("(max-width: 900px)").matches;
      toggle.hidden = !mobile;
      if (!mobile) {
        sidebar.classList.remove("open");
        document.body.classList.remove("sidebar-open");
      }
    }

    toggle.addEventListener("click", function () {
      sidebar.classList.toggle("open");
      document.body.classList.toggle("sidebar-open");
    });

    mq();
    window.addEventListener("resize", mq);
  }

  var input = document.getElementById("doc-search");
  var results = document.getElementById("search-results");
  if (!input || !results) return;

  var index = null;
  var loading = null;

  function load() {
    if (index) return Promise.resolve(index);
    if (!loading) {
      loading = fetch("search-index.json")
        .then(function (res) {
          return res.ok ? res.json() : [];
        })
        .catch(function () {
          return [];
        })
        .then(function (rows) {
          index = rows;
          return rows;
        });
    }
    return loading;
  }

  function score(row, q) {
    var label = row.label.toLowerCase();
    var heading = (row.heading || "").toLowerCase();
    var section = (row.section || "").toLowerCase();
    var slug = row.slug.toLowerCase();
    var best = -1;
    if (label === q) best = 100;
    else if (label.indexOf(q) === 0) best = 80;
    else if (label.indexOf(q) !== -1) best = 60;
    if (heading === q) best = Math.max(best, 90);
    else if (heading.indexOf(q) !== -1) best = Math.max(best, 50);
    if (best < 0 && section.indexOf(q) !== -1) best = 30;
    if (best < 0 && slug.indexOf(q) !== -1) best = 20;
    return best;
  }

  function render(rows) {
    if (!rows.length) {
      results.hidden = true;
      results.innerHTML = "";
      input.setAttribute("aria-expanded", "false");
      return;
    }
    results.innerHTML = "";
    var seen = {};
    rows.forEach(function (row) {
      var href = row.slug + ".html" + (row.hash ? "#" + row.hash : "");
      if (seen[href]) return;
      seen[href] = true;
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = href;
      var title = row.heading ? row.heading : row.label;
      a.textContent = title;
      var context = row.section
        ? row.section + (row.heading ? " · " + row.label : "")
        : "Docs";
      var span = document.createElement("span");
      span.className = "search-context";
      span.textContent = context;
      li.appendChild(a);
      li.appendChild(span);
      results.appendChild(li);
    });
    results.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function update() {
    var q = input.value.trim().toLowerCase();
    if (q.length < 2) {
      render([]);
      return;
    }
    load().then(function (rows) {
      var scored = [];
      for (var i = 0; i < rows.length; i++) {
        var s = score(rows[i], q);
        if (s > 0) scored.push({ row: rows[i], score: s });
      }
      scored.sort(function (a, b) {
        return b.score - a.score;
      });
      render(
        scored.slice(0, 8).map(function (item) {
          return item.row;
        }),
      );
    });
  }

  input.addEventListener("input", update);
  input.addEventListener("focus", update);
  input.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      input.value = "";
      render([]);
    }
  });
  document.addEventListener("click", function (event) {
    if (!sidebar || sidebar.contains(event.target)) return;
    render([]);
  });

  window.addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key === "k") {
      event.preventDefault();
      input.focus();
    }
  });
})();
