(function () {
  var toggle = document.querySelector(".sidebar-toggle");
  var sidebar = document.getElementById("sidebar");
  if (!toggle || !sidebar) return;

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
})();
