// Shared player-display primitives used by BOTH the Player Rankings table and the
// Mock Draft detail sidebar, so the two views render categories, stars, tags, trends,
// and tiers identically — one implementation, no divergence. Every function here is
// pure (no page state), so it's safe to import into either page's module script.
//
// The star primitives, formatStat, and the tag/trend/tier renderers were lifted
// verbatim out of fantasyedge-rankings.html; the *Block / categoryRows / prevYear
// helpers are the shared building blocks the Mock Draft sidebar adds on top.

// --- Stars / category pills (the "N-Cat" strength rating) --------------------------
// 1 tag = 1 star, straight through; display caps at 5 with a "+" when a player maxes
// all their sport's categories (6 for MLB, so a 6-cat player is "5 star+").
export function getStarCount(cats) {
  return Array.isArray(cats) ? cats.length : 0;
}
export function getStarLabel(n) {
  if (n <= 0) return 'No categories';
  return n > 5 ? '5-Cat+' : n + '-Cat';
}
export function renderStars(n) {
  let h = '';
  const filled = Math.min(n, 5);
  for (let i = 1; i <= 5; i++) h += i <= filled ? '<span class="star-filled">★</span>' : '<span class="star-empty">★</span>';
  if (n > 5) h += '<span class="star-plus">+</span>'; // all categories → "5 star+"
  return h;
}
// The full stars cell/block: filled stars + the N-Cat label + the category pills. This
// is the exact markup the Rankings table's stars cell used, now shared so the Mock Draft
// sidebar shows the identical block.
export function renderStarsBlock(cats) {
  const n = getStarCount(cats);
  const pills = (Array.isArray(cats) ? cats : []).map((c) => `<span class="stars-cat-pill">${c}</span>`).join('');
  return `<div class="stars-row">${renderStars(n)}</div><div class="stars-label">${getStarLabel(n)}</div><div class="stars-cats">${pills}</div>`;
}

// --- Cell / badge renderers (verbatim from Rankings) ------------------------------
export function formatStat(v, label) {
  if (v === null || v === undefined || v === '—' || v === '') return '<span class="td-stat muted">—</span>';
  const lbl = label ? `<span class="td-stat-label">${label}</span>` : '';
  return `${lbl}<span class="td-stat">${v}</span>`;
}
export function getTrendHTML(trend, val) {
  // Trend mirrors the HOT/COLD form signal (recent vs season avg); flat = no data.
  if (trend === 'up') return `<span class="trend-up">▲ ${val || ''}</span>`;
  if (trend === 'down') return `<span class="trend-down">▼ ${val || ''}</span>`;
  return `<span class="trend-flat">—</span>`;
}
// Only two badges now: HOT and COLD, driven by real recent form (enrichForm).
export function getTagHTML(tag, reason) {
  if (tag !== 'hot' && tag !== 'cold') return '';
  const label = tag === 'hot' ? '🔥 HOT' : '❄️ COLD';
  const cls = tag === 'hot' ? 'tag-fire' : 'tag-slump';
  // The badge carries WHY it fired — the surging/slumping category line from enrichForm
  // (e.g. ".367 AVG, 6 HR · last 15"). Shown inline (muted) and as a hover tooltip.
  const r = reason ? ` <span class="tag-reason">${reason}</span>` : '';
  return `<span class="tag-badge ${cls}"${reason ? ` title="${reason}"` : ''}>${label}</span>${r}`;
}
// NFL consistency score (replaces the star rating / N-Cat pills on the roto sports, which don't
// map to a points league): weekly floor (P25/P50, higher = steadier) + a separate ceiling
// (P90 upside), from enrichNflConsistency. Used anywhere a player's "strength rating" is shown
// for NFL — currently the Rankings stars-cell and the Mock Draft / Draft Mode detail panel.
export function renderConsistencyHTML(p) {
  if (p.consistency == null) return '<span class="td-stat muted">—</span>';
  const ceil = p.ceiling != null
    ? ` <span class="consist-ceil" title="Ceiling — 90th-percentile game (upside), PPR">⌃${p.ceiling}</span>`
    : '';
  return `<span class="consist" title="Consistency — weekly floor vs a typical game (P25/P50); higher = steadier">${p.consistency}</span>${ceil}`;
}

// PGA DFS value tier (replaces the star rating on the golf board): VALUE (produces
// above price), CHALK (obvious stud), SOLID (dependable), PUNT (salary saver).
// A small note flags golfers not in this week's field (their CUT%/FIT are blank).
export function getTierHTML(tier, inField) {
  const labels = { value: 'VALUE', chalk: 'CHALK', solid: 'SOLID', punt: 'PUNT' };
  const key = labels[tier] ? tier : 'solid';
  const note = inField === false ? '<span class="tier-note">not in field</span>' : '';
  return `<span class="tier-badge tier-${key}">${labels[key]}</span>${note}`;
}

// --- Full category list for the Mock Draft sidebar --------------------------------
// Column stat LABEL -> the key under which its z-score lives in p.z (mirrors the Rankings
// STAT_META roll keys). Labels absent here (NHL/NFL/PGA columns, which carry no z block)
// simply show their value with no z.
const LABEL_ZKEY = {
  AVG: 'avg', OBP: 'obp', OPS: 'ops', HR: 'hr', RBI: 'rbi', R: 'r', SB: 'sb',
  K: 'k', W: 'w', SV: 'sv', HD: 'hd', ERA: 'era', WHIP: 'whip', IP: 'ip',
  PTS: 'pts', REB: 'reb', AST: 'ast', '3PM': 'tpm', STL: 'stl', BLK: 'blk',
};

// One row per display category: its label, the season value (from the s1..s8 slots the
// rankings board uses), a numeric parse for value-sorting, and the per-category z (for
// impact-sorting), when the sport carries a z block.
export function categoryRows(p) {
  const labels = Array.isArray(p.statLabels) ? p.statLabels : [];
  const vals = [p.s1, p.s2, p.s3, p.s4, p.s5, p.s6, p.s7, p.s8];
  const z = p.z || {};
  return labels.map((cat, i) => {
    const raw = vals[i];
    const zk = LABEL_ZKEY[cat];
    const zval = zk != null && z[zk] != null ? Number(z[zk]) : null;
    const num = raw == null || raw === '—' ? NaN : parseFloat(String(raw).replace(/,/g, ''));
    return { cat, val: raw == null || raw === '' ? '—' : raw, num: isFinite(num) ? num : null, z: zval };
  });
}

// The sortable category list HTML for the sidebar. sortMode: 'natural' (as listed),
// 'value' (by raw stat value, high→low), or 'impact' (by per-category z, high→low).
// Missing values/z sink to the bottom in the sorted modes.
export function renderCategoryList(p, sortMode = 'natural') {
  let rows = categoryRows(p);
  if (!rows.length) return '<div class="pd-empty">No category stats for this player.</div>';
  const sink = (x) => (x == null ? -Infinity : x);
  if (sortMode === 'value') rows = rows.slice().sort((a, b) => sink(b.num) - sink(a.num));
  else if (sortMode === 'impact') rows = rows.slice().sort((a, b) => sink(b.z) - sink(a.z));
  return `<div class="pd-cats">${rows.map((r) => {
    const zc = r.z == null ? 'pd-z-none' : r.z >= 0 ? 'pd-z-pos' : 'pd-z-neg';
    const zt = r.z == null ? '—' : (r.z >= 0 ? '+' : '') + r.z.toFixed(2);
    return `<div class="pd-cat-row"><span class="pd-cat">${r.cat}</span><span class="pd-val">${r.val}</span><span class="pd-z ${zc}">${zt}</span></div>`;
  }).join('')}</div>`;
}

// NFL "Opportunity" context (Phase 2): a skill player's team target share + offensive pace, from
// the backend `opportunity: { label, targetShare, paceIndex, paceBucket, applied, appliedTilt,
// season }`. In-season these NUDGE the blended ranking (a capped tilt on the current-pace leg,
// applied by nflBlend) — `applied` is true. In the offseason the same figures are LAST season's
// usage, shown as context only and never applied — the projection already prices in new-team roles.
// `variant`: 'compact' (one inline line, for the draft board) or 'block' (a small labeled section).
// Returns '' when there's nothing notable to show (no team context, or an average-pace QB).
export function renderOpportunity(p, variant = 'block') {
  const o = p && p.opportunity;
  if (!o || !o.label) return '';
  const applied = !!o.applied;
  if (variant === 'compact') {
    return `<div class="opp">Opportunity: ${o.label}${applied ? '' : ' · context only'}</div>`;
  }
  const seasonTag = o.season ? `${o.season} usage` : 'prior usage';
  let foot;
  if (applied) {
    const pct = Math.round((o.appliedTilt || 0) * 100);
    foot = pct !== 0
      ? `<div class="opp-note">${pct > 0 ? '+' : ''}${pct}% on current-pace value</div>`
      : `<div class="opp-note">Applied to the ranking (current-pace leg)</div>`;
  } else {
    foot = `<div class="opp-note">Context only (${seasonTag}) — not applied to the ranking out of season.</div>`;
  }
  return `<div class="opp-block"><div class="opp-hd">Opportunity</div><div class="opp-body">${o.label}</div>${foot}</div>`;
}

// Prior-year full-season line (e.g. an NFL player's TDs, or the full roto line for other
// sports), from the backend `prevYear: { season, headline, line: [{cat,val}] }`. Empty
// when the pipeline had no prior season for that player.
export function renderPrevYear(p) {
  const pv = p.prevYear;
  if (!pv || !Array.isArray(pv.line) || !pv.line.length) {
    return '<div class="pd-prev pd-empty">No prior-season line on record.</div>';
  }
  const cells = pv.line
    .filter((c) => c && c.val != null && c.val !== '—')
    .map((c) => `<span class="pd-prev-cell"><b>${c.val}</b> ${c.cat}</span>`)
    .join('');
  const head = pv.headline ? `<span class="pd-prev-headline">${pv.headline}</span>` : '';
  return `<div class="pd-prev"><div class="pd-prev-hd">${pv.season || 'Prior'} season${head ? ' · ' : ''}${head}</div><div class="pd-prev-line">${cells || '<span class="pd-empty">—</span>'}</div></div>`;
}
