// Runs before first paint (an external file, because the page's CSP forbids inline scripts).
(function () {
  var t = "dark";
  try {
    var p = localStorage.getItem("devicedock.theme");
    t = p === "light" || p === "dark" ? p : matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch (e) {}
  document.documentElement.setAttribute("data-theme", t);
})();
