/* FantasyEdge — mobile nav drawer toggle (mobile-only enhancement).
   Wires the hamburger + backdrop to toggle `body.nav-open`. No-ops on pages
   without a drawer (e.g. the landing page). Purely presentational; changes no
   app data, routes, or feature handlers. */
(function () {
  function init() {
    var toggle = document.querySelector('.nav-toggle');
    var backdrop = document.querySelector('.nav-backdrop');
    var close = function () { document.body.classList.remove('nav-open'); };
    if (toggle) toggle.addEventListener('click', function () { document.body.classList.toggle('nav-open'); });
    if (backdrop) backdrop.addEventListener('click', close);
    // Tapping a nav link closes the drawer.
    document.querySelectorAll('.sidebar-nav a').forEach(function (a) { a.addEventListener('click', close); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
