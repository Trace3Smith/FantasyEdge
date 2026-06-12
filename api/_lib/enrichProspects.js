// Phase 2 orchestrator. Bolts minor-league stats + an AI fantasy synopsis onto
// the Phase 1 dataset for hitting prospects, then persists prospect state to KV.
// Runs ONLY in the daily cron (refresh.js) — never in the request-path cold
// start — because it fans out to FanGraphs, Chadwick, MiLB leaderboards, and the
// Anthropic API.
//
// Rich-treatment pools (hitters only):
//   1. Proactive — each org's top-10 hitting prospects (FanGraphs THE BOARD).
//   2. On-demand — a player who newly appears on a 40-man with no MLB stats yet
//      and isn't already tracked: enriched once, then maintained until he records
//      an MLB stat.
//
// Lifecycle: MiLB lines + synopsis ride a record ONLY while it has zero MLB stats
// this season. The first MLB stat retires the prospect treatment and the player
// flows through Phase 1 as a normal big leaguer. Everything is keyed on MLBAM
// person.id, so a promoted prospect merges into one record — never a duplicate.

import { PROSPECT_STATE_KEY } from './kv.js';
import { loadBoard, topHittersByOrg } from './fangraphs.js';
import { resolveCrosswalk } from './crosswalk.js';
import { fetchMilbHitting } from './milb.js';
import { snapshotOf, detectEvent, generateSynopsis } from './synopsis.js';

const API = 'https://statsapi.mlb.com/api/v1';
const HEADERS = { 'User-Agent': 'Mozilla/5.0' };
const GEN_CONCURRENCY = 6;

// FanGraphs org abbreviations that differ from statsapi's, for team-name display.
const ORG_ALIAS = { WSN: 'WSH', CHW: 'CWS', KCR: 'KC', SDP: 'SD', SFG: 'SF', TBR: 'TB' };

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function orgNameMap() {
  try {
    const d = await (await fetch(`${API}/teams?sportId=1`, { headers: HEADERS })).json();
    const m = new Map();
    for (const t of d.teams || []) if (t.abbreviation) m.set(t.abbreviation, t.name);
    return m;
  } catch {
    return new Map();
  }
}

export async function enrichProspects(dataset, { season = new Date().getFullYear() } = {}, redis) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const prior = (await redis.get(PROSPECT_STATE_KEY).catch(() => null)) || { players: {}, board: null };
  const priorPlayers = prior.players || {};

  // MiLB stats always come fresh (independent of the FanGraphs fetch).
  const milb = await fetchMilbHitting({ season });
  const orgNames = await orgNameMap();

  // --- Resolve the tracked top-10-hitters-per-org list to MLBAM ids ---------
  // The board comes from the committed snapshot (the live FanGraphs fetch is
  // Cloudflare-blocked server-side); loadBoard tries live first, falls back to
  // the snapshot. `degraded` here means we did NOT get a fresh live board.
  let tracked = []; // [{ mlbam, name, org, pos, fv, orgRank, bats, eta }]
  let unmatched = 0;
  const loaded = await loadBoard({ season });
  const degraded = !loaded.live;
  const top = topHittersByOrg(loaded.hitters, 10);
  const xwalk = await resolveCrosswalk(top.map((h) => h.fgId).filter(Boolean), redis);
  const seen = new Set();
  for (const h of top) {
    let mlbam = h.fgId ? xwalk.get(h.fgId) : null;
    if (mlbam == null) {
      // Name-match fallback against the MLBAM-keyed MiLB pool (recovers board
      // rows that carry only an "sa…" id or that Chadwick doesn't cover).
      const id = milb.byName.get(milb.normName(h.name));
      if (id) mlbam = id;
    }
    if (mlbam == null) {
      unmatched++;
      continue;
    }
    if (seen.has(mlbam)) continue;
    seen.add(mlbam);
    tracked.push({
      mlbam,
      name: h.name,
      org: h.org,
      pos: h.pos,
      fv: h.fv,
      orgRank: h.orgRank,
      bats: h.bats,
      eta: h.eta,
    });
  }
  const board = { fetchedAt: loaded.fetchedAt, slug: loaded.slug, live: loaded.live, tracked };

  const trackedIds = new Set(tracked.map((t) => t.mlbam));
  const idMap = new Map(dataset.players.map((p) => [p.id, p]));

  // --- Assemble the maintain set: tracked ∪ on-demand call-ups --------------
  const maintain = new Map(); // mlbam -> meta
  for (const t of tracked) maintain.set(t.mlbam, { ...t, source: 'tracked' });

  for (const rec of dataset.players) {
    if (!rec.rostered || rec.hasStats) continue; // call-ups are statless 40-man players
    if (trackedIds.has(rec.id)) continue;
    const seenBefore = !!priorPlayers[rec.id]; // already enriched on an earlier rebuild
    const isNew = !seenBefore; // "newly appears on a 40-man, not already tracked"
    if (seenBefore || isNew) {
      maintain.set(rec.id, {
        mlbam: rec.id,
        name: rec.name,
        org: rec.team,
        pos: rec.pos,
        fv: null,
        orgRank: null,
        bats: null,
        eta: null,
        source: 'oncall',
      });
    }
  }

  // --- Build work items (everything except the synopsis API call) -----------
  const newPlayers = {};
  const work = []; // items needing a (re)generated synopsis
  let created = 0;
  let retired = 0;

  for (const [mlbam, meta] of maintain) {
    const rec = idMap.get(mlbam);
    if (rec && rec.hasStats) {
      // Lifecycle retire: has MLB stats this season → normal Phase 1 player.
      retired++;
      continue;
    }

    const lines = milb.byId.get(mlbam) || [];
    const cur = snapshotOf(lines);
    const p = priorPlayers[mlbam];
    const event = lines.length ? detectEvent(p, cur, now) : null;

    // Stalled-detection bookkeeping (independent of synopsis baseline).
    let lastTotalPa = p?.lastTotalPa ?? cur.totalPa;
    let lastPaGainAt = p?.lastPaGainAt ?? nowIso;
    if (cur.totalPa > lastTotalPa) {
      lastTotalPa = cur.totalPa;
      lastPaGainAt = nowIso;
    }

    // Attach the display fields now (synopsis filled in below).
    let target = rec;
    if (!target) {
      target = {
        id: mlbam,
        name: meta.name,
        team: orgNames.get(ORG_ALIAS[meta.org] || meta.org) || meta.org,
        pos: meta.pos || '—',
        rostered: false,
        hasStats: false,
        searchOnly: true,
        emoji: '⚾',
      };
      dataset.players.push(target);
      idMap.set(mlbam, target);
      created++;
    }
    target.searchOnly = true;
    target.prospect = true;
    if (meta.fv != null) target.fv = meta.fv;
    if (meta.orgRank != null) target.prospectRank = meta.orgRank;
    if (meta.eta != null) target.eta = meta.eta;
    if (meta.bats) target.bats = meta.bats;
    target.milb = lines;
    target.topLevel = cur.topLevel;

    const state = {
      name: meta.name,
      org: meta.org,
      pos: meta.pos,
      fv: meta.fv,
      orgRank: meta.orgRank,
      status: meta.source,
      topLevel: cur.topLevel,
      synopsis: p?.synopsis || null,
      synopsisAt: p?.synopsisAt || null,
      snapshot: p?.snapshot || cur,
      lastTotalPa,
      lastPaGainAt,
      stalledFiredAt: p?.stalledFiredAt || null,
      firstSeen: p?.firstSeen || nowIso,
    };
    newPlayers[mlbam] = state;
    if (target.synopsis === undefined && state.synopsis) target.synopsis = state.synopsis;

    if (event && lines.length) {
      work.push({ mlbam, target, state, cur, event, meta, lines });
    }
  }

  // --- Generate synopses for tripped events (bounded concurrency) -----------
  let generated = 0;
  await mapLimit(work, GEN_CONCURRENCY, async (w) => {
    const text = await generateSynopsis({
      name: w.meta.name,
      pos: w.meta.pos,
      bats: w.meta.bats,
      org: w.meta.org,
      fv: w.meta.fv,
      eta: w.meta.eta,
      milb: w.lines,
    });
    if (text) {
      w.target.synopsis = text;
      w.state.synopsis = text;
      w.state.synopsisAt = nowIso;
      w.state.snapshot = w.cur; // reset the event baseline
      if (w.event === 'stalled') w.state.stalledFiredAt = nowIso;
      generated++;
    }
  });

  // --- Persist state --------------------------------------------------------
  const counts = {
    tracked: tracked.length,
    onCall: [...maintain.values()].filter((m) => m.source === 'oncall').length,
    created,
    retired,
    generated,
    unmatched,
    degraded,
    withSynopsis: Object.values(newPlayers).filter((s) => s.synopsis).length,
    maintained: Object.keys(newPlayers).length,
  };
  await redis
    .set(PROSPECT_STATE_KEY, { builtAt: nowIso, board, players: newPlayers, counts })
    .catch(() => {});

  dataset.counts = { ...dataset.counts, prospects: counts };
  return counts;
}
