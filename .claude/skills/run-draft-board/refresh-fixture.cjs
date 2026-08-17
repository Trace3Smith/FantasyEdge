#!/usr/bin/env node
/**
 * Rebuild fixtures/nfl-sports.json from the LIVE production /api/sports (real players,
 * projections, ADP, ranks), trimmed to top-90 skill + all K/DST. If production already
 * serves kdst enrichment (i.e. this feature branch is deployed), it's kept as-is; until
 * then, plausible kdst signals are injected so the board can render the v1-v4 features.
 *
 * Usage: node refresh-fixture.cjs [prodBaseUrl]
 *   default prod: https://fantasy-edge-nine.vercel.app
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const PROD = (process.argv[2] || 'https://fantasy-edge-nine.vercel.app').replace(/\/$/, '');
const OUT = path.join(__dirname, 'fixtures/nfl-sports.json');
const DOME = new Set(['ARI','ATL','DAL','DET','HOU','IND','LV','MIN','NO','LAR','LAC']);

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)); }).on('error', reject);
  });
}

(async () => {
  console.log('fetching', PROD + '/api/sports?sport=nfl ...');
  const d = JSON.parse(await get(PROD + '/api/sports?sport=nfl'));
  const ps = d.players || [];
  const proj = (p) => (p.proj && p.proj.fpts) || 0;
  const ks = ps.filter((p) => p.pos === 'K').sort((a, b) => proj(b) - proj(a));
  const ds = ps.filter((p) => p.pos === 'DST').sort((a, b) => proj(b) - proj(a));

  const alreadyEnriched = [...ks, ...ds].some((p) => p.kdst);
  if (!alreadyEnriched) {
    console.log('production is NOT kdst-enriched yet — injecting fixture enrichment');
    ks.forEach((p, i) => {
      const off = (i % 32) + 1, dome = DOME.has(p.team);
      const parts = [`proj ${Math.round(proj(p))} pts`, `${p.team} offense #${off}`];
      if (dome) parts.push('dome');
      parts.push('lead K');
      p.kdst = { projFpts: proj(p), offenseRank: off, defenseRank: null, takeawayRank: null, dome, jobRole: 'lead', label: parts.join(' · ') };
    });
    ds.forEach((p, i) => {
      const dr = (i % 32) + 1, tr = ((i * 7 + 3) % 32) + 1;
      p.kdst = { projFpts: proj(p), offenseRank: null, defenseRank: dr, takeawayRank: tr, dome: null, jobRole: null,
        label: `proj ${Math.round(proj(p))} pts · ${p.team} defense #${dr} · takeaways #${tr}` };
    });
  } else {
    console.log('production already serves kdst enrichment — keeping it as-is');
  }

  const skill = ps.filter((p) => !['K', 'DST'].includes(p.pos) && p.rank != null).sort((a, b) => a.rank - b.rank).slice(0, 90);
  d.players = [...skill, ...ks, ...ds].sort((a, b) => (a.rank || 9999) - (b.rank || 9999));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(d));
  console.log('wrote', OUT, '|', d.players.length, 'players |', ks.length, 'K +', ds.length, 'DST |', Math.round(fs.statSync(OUT).size / 1024), 'KB');
})().catch((e) => { console.error('refresh failed:', e.message); process.exit(1); });
