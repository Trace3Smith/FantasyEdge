// Real PGA Tour ball-striking stats for the DFS golf board, pulled from the PGA
// Tour's own free GraphQL endpoint (orchestrator.pgatour.com). This is the only
// free source of STROKES GAINED — ESPN's golf feed exposes FIR/GIR/scrambling but
// no SG. The `x-api-key` below is the PGA Tour web app's public client key (the
// same one pgatour.com ships to every browser); no account or paid tier required.
//
// For each statId we read the per-player season "Avg" (SG categories) or "%"
// (scrambling / fairways / greens). Everything is keyed by a normalized player name
// (normName) so it joins to the OWGR backbone in buildPgaDataset. Failure-tolerant:
// a stat that errors just comes back as an empty map and shows '—' on the board.

import { normName } from './golf.js';

const PGA_GQL = 'https://orchestrator.pgatour.com/graphql';
const PGA_KEY = 'da2-gsrx5bibzbb4njvhl7t37wqyl4'; // public pgatour.com web client key

// PGA Tour stat IDs. SG categories report a per-round "Avg"; the percentage stats
// report a "%". tourCode R = the PGA Tour.
const STAT_IDS = {
  ott:  '02567', // SG: Off-the-Tee
  app:  '02568', // SG: Approach the Green
  putt: '02564', // SG: Putting
  scr:  '130',   // Scrambling %
  fir:  '102',   // Driving Accuracy % (fairways in regulation)
  gir:  '103',   // Greens in Regulation %
};

// Which stat row to read per category, and how to parse it. SG -> the "Avg" value
// (a signed per-round number like 0.76); percentages -> the "%" value (e.g. "68.90%").
const SG_KEYS = new Set(['ott', 'app', 'putt']);

const toNum = (v) => {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[%,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

async function statRows(statId, year) {
  const body = {
    query: `query{statDetails(tourCode:R,statId:"${statId}",year:${year}){statTitle rows{... on StatDetailsPlayer{playerName stats{statName statValue}}}}}`,
  };
  const r = await fetch(PGA_GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': PGA_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`PGA GraphQL ${r.status} for stat ${statId}`);
  const j = await r.json();
  return j?.data?.statDetails?.rows || [];
}

// Read one stat into a Map(normName -> number). `pick` chooses the preferred stat
// label inside each row, falling back to the first value.
async function statMap(statId, year, pick) {
  const rows = await statRows(statId, year);
  const out = new Map();
  for (const row of rows) {
    const nm = normName(row.playerName);
    if (!nm) continue;
    const stats = row.stats || [];
    const hit = stats.find((s) => s.statName === pick) || stats[0];
    const v = toNum(hit?.statValue);
    if (v != null) out.set(nm, v);
  }
  return out;
}

const EMPTY = () => ({ ott: null, app: null, putt: null, scr: null, fir: null, gir: null });
const hasComposite = (r) => r && r.ott != null && r.app != null && r.putt != null;

// Pull one season's full SG/accuracy slate into Map(normName -> {ott,app,putt,scr,fir,gir}).
// Tolerates per-stat failures (a stat that errors just leaves its field null).
async function fetchSeason(year) {
  const entries = Object.entries(STAT_IDS);
  const maps = await Promise.all(
    entries.map(([k, id]) => statMap(id, year, SG_KEYS.has(k) ? 'Avg' : '%').catch(() => new Map())),
  );
  const byName = new Map();
  entries.forEach(([k], i) => {
    for (const [nm, v] of maps[i]) {
      if (!byName.has(nm)) byName.set(nm, EMPTY());
      byName.get(nm)[k] = v;
    }
  });
  return byName;
}

// Strokes-gained slate keyed by normalized name. We lead with the CURRENT season,
// then backfill from the PRIOR season for any player who hasn't met this season's
// minimum-rounds qualifier yet (the PGA Tour SG leaderboards exclude them, which early
// in a season drops marquee names like McIlroy). Season-long SG is a stable skill
// signal, so a prior-season line is a sensible stand-in for a DFS board until the
// current one qualifies. Returns { year, priorYear, byName, fromPrior: Set<normName> }.
export async function fetchPgaStats() {
  // Resolve the season off SG:OTT — fall back a year if the current one is too thin
  // (e.g. querying January before the tour ramps up).
  let year = new Date().getUTCFullYear();
  let ottRows = await statRows(STAT_IDS.ott, year).catch(() => []);
  if (ottRows.length < 20) {
    const prev = year - 1;
    const prevRows = await statRows(STAT_IDS.ott, prev).catch(() => []);
    if (prevRows.length > ottRows.length) year = prev;
  }
  const priorYear = year - 1;

  const [current, prior] = await Promise.all([fetchSeason(year), fetchSeason(priorYear)]);

  const byName = new Map(current);
  const fromPrior = new Set();
  for (const [nm, rec] of prior) {
    // Use the prior season only where the current one lacks a full SG composite for
    // this player, and only if prior actually has one (don't overwrite real data).
    if (!hasComposite(byName.get(nm)) && hasComposite(rec)) {
      byName.set(nm, rec);
      fromPrior.add(nm);
    }
  }

  return { year, priorYear, byName, fromPrior };
}
