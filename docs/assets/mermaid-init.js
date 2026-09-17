(function () {
  function normalizeDiagrams() {
    document.querySelectorAll(".prose .mermaid svg").forEach(function (svg) {
      var viewBox = svg.getAttribute("viewBox");
      if (!viewBox) return;
      svg.removeAttribute("height");
      svg.style.width = "100%";
      svg.style.height = "auto";
      svg.style.maxWidth = "100%";
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    });
  }

  function boot() {
    if (typeof mermaid === "undefined") return;
    mermaid.initialize({
      startOnLoad: false,
      theme: "neutral",
      securityLevel: "loose",
    });
    mermaid.run({ querySelector: ".prose .mermaid" }).then(normalizeDiagrams);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
