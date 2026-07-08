// Prospect call-up monitoring (Premium). Tracks the minor-league prospects a user
// stashes on an ESPN roster — plus any they explicitly Watch on a drop suggestion — and
// detects when one is CALLED UP, i.e. their status flips from "in the minors" to "on an
// active MLB roster". Call-ups surface as an alert on the Team Manager card; prospects
// the user flagged to reclaim get a high-priority reclaim prompt (a one-tap "reclaim on
// ESPN" the user confirms — we never execute an unattended roster transaction).
//
// SIGNAL: our MLB dataset marks a player `prospect: true` ONLY while they have zero MLB
// stats this season (see enrichProspects.js — "the first MLB stat retires the prospect
// treatment"). So the prospect flag flipping true → false IS the call-up. This is the
// same cross-source signal the rest of the app already trusts; detection lands within a
// day of the flip (the dataset rebuilds on the daily refresh cron). We match ESPN roster
// players to dataset records BY NORMALIZED NAME — ESPN player ids are not our MLBAM ids.
//
// State lives in Redis at espn:prospectwatch:{userId}, keyed by ESPN player id:
//   { id, name, pos, lg, leagueName, source:'roster'|'watch', reclaim,
//     status:'minors'|'active', stashedSince, seenAt, calledUpAt, acked }
// It holds only roster metadata — never cookies or anything sensitive.

import { normName } from './golf.js';

const watchKey = (userId) => `espn:prospectwatch:${userId}`;
export const LONG_STASH_DAYS = 60;   // "long-stashed" threshold for the drop-rec context
const CALLUP_ALERT_DAYS = 21;        // keep surfacing a call-up alert this long until acked

export async function getWatch(redis, userId) {
  return (await redis.get(watchKey(userId))) || {};
}
export async function setWatch(redis, userId, map) {
  await redis.set(watchKey(userId), map || {});
}

export function daysSince(iso, now = Date.now()) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86400000)) : 0;
}
const withinDays = (iso, n, now = Date.now()) => !!iso && daysSince(iso, now) <= n;

// Build name-keyed lookups from the FULL dataset (incl. searchOnly prospects):
//   prospects: normName → rec for records still flagged prospect (in the minors)
//   all:       normName → rec for every record (to spot a former prospect now promoted)
export function prospectIndex(players = []) {
  const prospects = new Map();
  const all = new Map();
  for (const p of players) {
    const key = normName(p.name);
    if (!key) continue;
    if (!all.has(key)) all.set(key, p);
    if (p.prospect === true && !prospects.has(key)) prospects.set(key, p);
  }
  return { prospects, all };
}

// Current status of a watched player from the freshest dataset record:
//   'minors' — still flagged a prospect (zero MLB stats this season)
//   'active' — a known record NOT flagged a prospect (got MLB action = called up)
//   null     — not found / can't classify (leave the last-known status untouched)
function statusFromDataset(idx, name) {
  const rec = idx.all.get(normName(name));
  if (!rec) return null;
  return rec.prospect === true ? 'minors' : 'active';
}

// Reconcile the watch map against the user's current MLB league rosters + the dataset.
// - Auto-tracks any roster player currently flagged a prospect (source 'roster').
// - Flips watched entries minors→active when the dataset shows a call-up, recording
//   calledUpAt (once) and surfacing a call-up alert until acked / aged out.
// - Prunes roster-stashed prospects the user quietly dropped (unless they Watched them).
// Pure function (no I/O): returns { watch, byLeague } where
//   byLeague[lgKey] = { callUps:[{id,name,pos,reclaim,at}], stashed:[{id,name,pos,days,longStash}] }.
export function reconcileWatch({ watch = {}, leagues = [], idx, now = Date.now() }) {
  const nowIso = new Date(now).toISOString();
  const out = {};
  for (const [k, v] of Object.entries(watch)) out[k] = { ...v };
  const seenIds = new Set();
  const fetchedKeys = new Set();

  // 1) Auto-track current roster prospects + refresh where we last saw each.
  for (const lg of leagues) {
    if (!lg || !lg.team || !Array.isArray(lg.roster)) continue;
    const lgKey = `${lg.season}:${lg.leagueId}:${lg.teamId ?? lg.team.id}`;
    fetchedKeys.add(lgKey);
    for (const rp of lg.roster) {
      if (rp.id == null) continue;
      if (!idx.prospects.has(normName(rp.name))) continue; // only track current prospects
      const idStr = String(rp.id);
      seenIds.add(idStr);
      const prev = out[idStr];
      out[idStr] = {
        id: rp.id,
        name: rp.name,
        pos: rp.pos || prev?.pos || '',
        lg: lgKey,
        leagueName: lg.leagueName || prev?.leagueName || '',
        source: prev?.source === 'watch' ? 'watch' : 'roster',
        reclaim: prev?.reclaim || false,
        status: prev?.status === 'active' ? 'active' : 'minors',
        stashedSince: prev?.stashedSince || nowIso,
        seenAt: nowIso,
        calledUpAt: prev?.calledUpAt || null,
        acked: prev?.acked || false,
      };
    }
  }

  // 2) Detect call-ups + bucket alerts/stash context by league.
  const byLeague = {};
  const bucket = (k) => (byLeague[k] || (byLeague[k] = { callUps: [], stashed: [] }));
  for (const [idStr, e] of Object.entries(out)) {
    const cur = statusFromDataset(idx, e.name);
    if (e.status === 'minors' && cur === 'active') {   // the call-up transition
      e.status = 'active';
      e.calledUpAt = e.calledUpAt || nowIso;
      e.acked = false;
    }
    if (e.status === 'active' && !e.acked && withinDays(e.calledUpAt, CALLUP_ALERT_DAYS, now)) {
      bucket(e.lg).callUps.push({ id: e.id, name: e.name, pos: e.pos, reclaim: !!e.reclaim, at: e.calledUpAt });
    } else if (e.status === 'minors' && cur !== 'active') {
      const days = daysSince(e.stashedSince, now);
      bucket(e.lg).stashed.push({ id: e.id, name: e.name, pos: e.pos, days, longStash: days >= LONG_STASH_DAYS });
      // Prune a roster-stashed prospect the user quietly dropped (not Watched): we looked
      // at that exact team this run and they're gone — stop tracking to bound the map.
      if (e.source === 'roster' && !e.reclaim && fetchedKeys.has(e.lg) && !seenIds.has(idStr)) delete out[idStr];
    } else if (e.status === 'active' && e.acked) {
      delete out[idStr]; // call-up handled — forget it
    }
  }
  return { watch: out, byLeague };
}

// Add / update / dismiss a watch entry from an explicit user action on the UI.
//   op 'watch'   → track this prospect and flag it for reclaim if called up
//   op 'unwatch' → clear the reclaim flag (keep passive roster tracking)
//   op 'ack'     → dismiss a surfaced call-up alert (stops re-surfacing it)
// Returns the updated map. Preserves stashedSince/status so days-in-minors stays honest.
export function applyWatchOp(watch = {}, { op, playerId, name, pos, lg, leagueName, now = Date.now() }) {
  const out = {};
  for (const [k, v] of Object.entries(watch)) out[k] = { ...v };
  const idStr = String(playerId);
  const nowIso = new Date(now).toISOString();
  const prev = out[idStr];
  if (op === 'ack') {
    if (prev) prev.acked = true;
    return out;
  }
  if (op === 'unwatch') {
    if (prev) prev.reclaim = false;
    return out;
  }
  // 'watch' (default): create or upgrade the entry and set the reclaim intent.
  out[idStr] = {
    id: Number(playerId) || playerId,
    name: name || prev?.name || '',
    pos: pos || prev?.pos || '',
    lg: lg || prev?.lg || '',
    leagueName: leagueName || prev?.leagueName || '',
    source: 'watch',
    reclaim: true,
    status: prev?.status || 'minors',
    stashedSince: prev?.stashedSince || nowIso,
    seenAt: nowIso,
    calledUpAt: prev?.calledUpAt || null,
    acked: prev?.acked || false,
  };
  return out;
}
