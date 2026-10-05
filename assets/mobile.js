/* FantasyEdge — mobile nav drawer toggle (mobile-only enhancement).
   Wires the hamburger + backdrop to toggle `body.nav-open`. No-ops on pages
   without a drawer (e.g. the landing page). Purely presentational; changes no
   app data, routes, or feature handlers. */
(function () {
  function init() {
    var toggle = document.querySelector('.nav-toggle');
    var backdrop = document.querySelector('.nav-backdrop');
    // Keep the button's label in step with the drawer (it renders as a close X while open).
    var sync = function () { if (toggle) toggle.setAttribute('aria-label', document.body.classList.contains('nav-open') ? 'Close menu' : 'Open menu'); };
    var close = function () { document.body.classList.remove('nav-open'); sync(); };
    if (toggle) toggle.addEventListener('click', function () { document.body.classList.toggle('nav-open'); sync(); });
    if (backdrop) backdrop.addEventListener('click', close);
    // Tapping a nav link closes the drawer.
    document.querySelectorAll('.sidebar-nav a').forEach(function (a) { a.addEventListener('click', close); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
