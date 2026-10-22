/* ==========================================================================
   View routing — nav.js
   Hash-based (#/library, #/read, #/journal, #/settings): no reloads, and the
   browser back button and refresh both work.
   Switch from anywhere with:  navigateTo("journal")
   ========================================================================== */
(function (global) {
  "use strict";

  var ROUTES = {
    library:  "library-view",
    read:     "reader-view",
    journal:  "journal-view",
    settings: "settings-view"
  };
  var DEFAULT_ROUTE = "library";

  var tabs = document.querySelectorAll(".nav-tab[data-route]");
  var reduceMotion = global.matchMedia("(prefers-reduced-motion: reduce)");
  var current = null;
  var token = 0;                 // cancels a pending swap if the user taps again
  var scrollMemory = {};

  function routeFromHash() {
    var name = global.location.hash.replace(/^#\/?/, "");
    return ROUTES.hasOwnProperty(name) ? name : DEFAULT_ROUTE;
  }

  function fadeMs() {
    return reduceMotion.matches ? 0 : 160;
  }

  function markTabs(name) {
    tabs.forEach(function (tab) {
      if (tab.dataset.route === name) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    });
  }

  function show(name, isInitial) {
    if (name === current) return;
    var myToken = ++token;
    var next = document.getElementById(ROUTES[name]);
    var prev = current ? document.getElementById(ROUTES[current]) : null;

    if (prev) scrollMemory[current] = global.scrollY;
    markTabs(name);

    function reveal() {
      if (myToken !== token) return;
      // Make sure nothing else is left showing after rapid taps.
      Object.keys(ROUTES).forEach(function (key) {
        var view = document.getElementById(ROUTES[key]);
        if (view !== next) { view.hidden = true; view.classList.remove("is-active"); }
      });
      next.hidden = false;
      global.scrollTo(0, scrollMemory[name] || 0);
      // Next frame so the opacity transition actually runs.
      global.requestAnimationFrame(function () {
        next.classList.add("is-active");
        if (!isInitial) next.focus({ preventScroll: true });
      });
      document.dispatchEvent(new CustomEvent("route:change", { detail: { route: name } }));
    }

    current = name;
    if (prev) {
      prev.classList.remove("is-active");
      global.setTimeout(reveal, fadeMs());
    } else {
      reveal();
    }
  }

  function onHashChange() { show(routeFromHash(), false); }

  global.navigateTo = function (name) {
    if (!ROUTES.hasOwnProperty(name)) return;
    if (global.location.hash !== "#/" + name) global.location.hash = "#/" + name;
    else show(name, false);
  };

  // Hide every view except the starting one, then show it.
  Object.keys(ROUTES).forEach(function (key) {
    var view = document.getElementById(ROUTES[key]);
    view.hidden = true;
    view.tabIndex = -1; // lets us move focus to the new view for screen readers
  });

  global.addEventListener("hashchange", onHashChange);
  show(routeFromHash(), true);
})(window);
