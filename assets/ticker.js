/* FantasyEdge — home-page live ticker.
   Populates the hero ticker from REAL data: for each sport, the existing public
   /api/sports?sport=<key> feed is read, and a sport is only included when it has
   current in-form players (a recent-form tag + reason) — i.e. it has live /
   recently-active games. Sports with no current activity (out of season) are
   omitted, and the ticker is hidden entirely when no sport qualifies. Nothing is
   hardcoded — no dates, no active-sport list, no player updates; it all comes
   from the same feed the Rankings page uses. Preserves the existing markup and
   marquee animation. */
(function () {
  // The universe of sports the app tracks; the DATA (not this list) decides
  // which actually appear, based on whether they have current in-form players.
  var SPORTS = [
    { key: 'mlb', tag: 'MLB' },
    { key: 'nba', tag: 'NBA' },
    { key: 'wnba', tag: 'WNBA' },
    { key: 'nhl', tag: 'NHL' },
    { key: 'nfl', tag: 'NFL' },
    { key: 'pga', tag: 'PGA' }
  ];
  var HOT_PER_SPORT = 4;
  var COLD_PER_SPORT = 1;

  var track = document.getElementById('ticker');
  var bar = track && track.closest ? track.closest('.ticker') : null;
  if (!track || !bar) return;

  // Hide until we have real data (avoids an empty bar / stale content).
  bar.style.display = 'none';

  function esc(s) { var d = document.createElement('div'); d.textContent = (s == null ? '' : String(s)); return d.innerHTML; }

  function itemHTML(sportTag, name, dir, reason) {
    var cls = (dir === 'down') ? 'down' : 'up';
    var arrow = (dir === 'down') ? '▼' : '▲'; // ▼ / ▲
    return '<span class="ticker-item"><span class="sport-tag">' + esc(sportTag) + '</span> ' +
      esc(name) + ' <span class="' + cls + '">' + arrow + ' ' + esc(reason) + '</span></span>';
  }

  function itemsForSport(data, sportTag) {
    var players = (data && data.players) || [];
    // A player carrying a recent-form tag + reason implies the sport is currently
    // live / in-season (the form window is the last handful of real games).
    var withForm = function (t) {
      return players.filter(function (p) { return p.tag === t && p.formReason; });
    };
    var out = [];
    withForm('hot').slice(0, HOT_PER_SPORT).forEach(function (p) {
      out.push(itemHTML(sportTag, p.name, 'up', p.formReason));
    });
    withForm('cold').slice(0, COLD_PER_SPORT).forEach(function (p) {
      out.push(itemHTML(sportTag, p.name, 'down', p.formReason));
    });
    return out;
  }

  function load(sport) {
    return fetch('/api/sports?sport=' + encodeURIComponent(sport.key))
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (data) { return { tag: sport.tag, items: data ? itemsForSport(data, sport.tag) : [] }; });
  }

  Promise.all(SPORTS.map(load)).then(function (results) {
    var all = [];
    results.forEach(function (r) { if (r.items.length) { all = all.concat(r.items); } });
    if (!all.length) { bar.style.display = 'none'; return; } // no live/scheduled sports -> stay hidden
    // Duplicate once for the seamless -50% marquee loop (matches the CSS keyframes).
    track.innerHTML = all.join('') + all.join('');
    bar.style.display = '';
  }).catch(function () { bar.style.display = 'none'; });
})();
