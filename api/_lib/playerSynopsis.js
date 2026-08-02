// Shared player-synopsis engine (Phase 0 scaffold).
//
// One place that turns a player's CURRENT dataset row into a short, RotoWire-style "why this is a
// good/bad play" note via the Anthropic API — reusing the generation + event-cache idea proven by
// the MiLB prospect synopses (synopsis.js), generalized to any sport.
//
// DESIGN
//   • On-demand, not daily-batch. A note is generated the first time it's requested, then cached in
//     KV (synopsisKey) and served until it goes stale.
//   • Fingerprint invalidation. Each sport declares a `fp(signals)` that captures ONLY the inputs
//     worth regenerating for (rank tier, form flip, projection bucket, day-of matchup, …). The cache
//     record stores that fingerprint; a request regenerates only when the current fingerprint differs.
//     This keeps token spend proportional to how much a player actually changes, not to roster size.
//   • Relevance-gated. `gate(p)` keeps generation to players worth a note (ranked, not search-only);
//     each sport can tighten it (e.g. NFL positional depth) in its own phase.
//   • Per-sport specialization lives in the REGISTRY. Phase 0 ships a GENERIC def that works for every
//     sport off common fields (rank, form, stat line); Phase 1 (NFL) and Phase 2 (MLB) register richer
//     signal extractors + prompts + fingerprints. The orchestrator and endpoint never change.
//   • Failure-tolerant. No ANTHROPIC_API_KEY or a failed call yields the last good cached note, else a
//     null note the UI simply doesn't render — it never throws into the caller.

import { createHash } from 'node:crypto';
import { redis, synopsisKey } from './kv.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const MODEL = 'claude-sonnet-4-6'; // same model the prospect synopses use
const MAX_TOKENS = 220;

// --- fingerprint --------------------------------------------------------------
// Deterministic stringify (keys sorted at every level) so the same signals always hash the same,
// regardless of property insertion order — otherwise the cache would churn on cosmetic reordering.
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
export function fingerprint(obj) {
  return createHash('sha1').update(stable(obj)).digest('hex').slice(0, 16);
}

// --- Anthropic call -----------------------------------------------------------
// Returns the note text, or null on no key / non-200 / malformed / network error (caller keeps any
// cached note on null). Mirrors synopsis.js's contract so behavior is identical across the app.
export async function generateText(system, user) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !user) return null;
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const text = j?.content?.[0]?.text?.trim();
    return text || null;
  } catch {
    return null;
  }
}

// --- generic (Phase 0) sport def ----------------------------------------------
// Works for any sport off fields every dataset row carries. Phase 1/2 override nfl/mlb with
// specialized defs; anything not in the registry falls back to this.

const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return isFinite(n) ? n : null; };

// The player's displayed stat line as [{ label, value }], from the same statLabels/s1..sN shape the
// rankings table and the Coach already read.
function statLine(p) {
  return (p.statLabels || [])
    .map((l, i) => { const v = p['s' + (i + 1)]; return v != null && v !== '—' ? { label: l, value: v } : null; })
    .filter(Boolean);
}

const GENERIC = {
  // Relevant = a ranked, non-search-only player. Sports tighten this in their own phase.
  gate: (p) => !!p && !p.searchOnly && p.rank != null,

  // The full signal set handed to the prompt.
  signals: (p /*, ctx */) => ({
    name: p.name,
    pos: p.pos && p.pos !== '—' ? p.pos : null,
    team: p.team && p.team !== '—' ? p.team : null,
    rank: p.rank ?? null,
    form: p.tag === 'hot' || p.tag === 'cold' ? { state: p.tag, reason: p.formReason || null } : null,
    stats: statLine(p),
  }),

  // The subset that triggers regeneration: rank TIER (bucketed by 5 so a one-spot move doesn't churn)
  // and the form state + reason. Season stat lines tick daily, so they're deliberately excluded here —
  // the specialized sport defs add the numbers that actually move a take (projection, matchup, …).
  fp: (s) => ({ tier: Math.ceil((s.rank || 999) / 5), form: s.form?.state || null, reason: s.form?.reason || null }),

  system:
    'You write terse fantasy-sports player notes in the style of RotoWire updates. Write 2-3 sentences, ' +
    'present tense, for a fantasy manager deciding whether to start or roster this player. ' +
    'Sentence 1: what the rank and stat line say about his current value. ' +
    'Sentence 2: what the recent form (if any) adds. ' +
    'Sentence 3: the fantasy takeaway (start with confidence, flex play, hold, sell-high, monitor, etc.). ' +
    'Be plain and confident with no hedging filler. Use ONLY the rank, stats, and form provided — do NOT ' +
    'invent injuries, opponents, matchups, role changes, comps, or any detail not given. If the data is thin, ' +
    'say so honestly rather than embellishing. Output only the note, no preamble.',

  user: (s) => {
    const where = [s.pos, s.team].filter(Boolean).join(', ');
    const lines = [
      `Player: ${s.name}${where ? ` (${where})` : ''}`,
      `Overall rank: #${s.rank ?? '—'}`,
    ];
    if (s.form) lines.push(`Recent form: ${s.form.state.toUpperCase()}${s.form.reason ? ` — ${s.form.reason}` : ''}`);
    const stats = s.stats.map((x) => `${x.label} ${x.value}`).join(', ');
    if (stats) lines.push(`Season stats: ${stats}`);
    return lines.join('\n');
  },
};

// --- NFL (Phase 1) ------------------------------------------------------------
// PPR-framed and season-aware. Draws on the NFL-specific enrichments already on the row: the blended
// ranking value (nflBlend, p.blend.inSeason), the Sleeper season projection (p.proj), weekly
// consistency + ceiling (enrichNflConsistency), team-context opportunity (enrichNflContext, in-season
// only), and the form badge. Offseason → draft framing (rank, projection, floor/ceiling profile);
// in-season → role/form/start-sit framing.
const NFL_SKILL = new Set(['QB', 'RB', 'WR', 'TE']);
const rnd = (v, step) => (v == null ? null : Math.round(v / step)); // bucket a value for the fingerprint

const NFL_DEF = {
  // Rosterable skill players only — K/DST get no note (thin, near-random signal), search-only excluded.
  gate: (p) => !!p && !p.searchOnly && p.rank != null && NFL_SKILL.has(p.pos),

  signals: (p, ctx = {}) => ({
    name: p.name,
    pos: p.pos,
    team: p.team && p.team !== '—' ? p.team : null,
    rank: p.rank ?? null,
    posRank: ctx.posRank ?? null,                          // e.g. WR3 — the endpoint derives it from the dataset
    inSeason: p.blend?.inSeason ?? null,
    games: p.games ?? null,
    projPts: p.proj?.pts?.ppr ?? (p.blend?.proj ?? null),  // projected season PPR points
    consistency: p.consistency ?? null,                    // P25/P50, higher = steadier
    ceiling: p.ceiling ?? null,                            // P90 weekly upside
    // Opportunity is current-season usage; offseason it's stale/last-season, so surface it ONLY when the
    // blend actually applied it (in-season). Mirrors how the rankings page treats the same figures.
    opportunity: (p.opportunity && p.opportunity.applied)
      ? { label: p.opportunity.label || null, targetShare: p.opportunity.targetShare ?? null, paceBucket: p.opportunity.paceBucket || null }
      : null,
    form: (p.tag === 'hot' || p.tag === 'cold') ? { state: p.tag, reason: p.formReason || null } : null,
    stats: statLine(p).filter((x) => x.label !== 'FPTS'),  // FPTS is the blended value → projPts already covers points
  }),

  // Regenerate on what moves an NFL take: positional tier, projection/consistency/ceiling buckets, a form
  // flip, the applied-opportunity bucket, and the season phase. Raw weekly stat totals are excluded (they
  // tick every week); the bucketed projection/consistency already capture real movement.
  fp: (s) => ({
    inSeason: s.inSeason,
    tier: Math.ceil((s.posRank || s.rank || 999) / 5),
    proj: rnd(s.projPts, 5),
    cons: rnd(s.consistency, 5),
    ceil: rnd(s.ceiling, 3),
    form: s.form?.state || null,
    reason: s.form?.reason || null,
    opp: s.opportunity ? `${s.opportunity.paceBucket || '-'}:${rnd((s.opportunity.targetShare || 0) * 100, 5)}` : null,
  }),

  system:
    'You write terse fantasy-football player notes in the style of RotoWire updates, for a PPR manager. ' +
    'Write 2-3 sentences, present tense. If the note is IN-SEASON, focus on the player\'s current value, recent ' +
    'form, and a start/sit or buy/sell read. If it is OFFSEASON (projecting the upcoming season), focus on ' +
    'DRAFT value — his rank, projected points, and his consistency/ceiling profile (steady floor vs ' +
    'boom-or-bust). Interpret CONSISTENCY as how close a bad week is to a typical week (higher = steadier, out ' +
    'of 100) and CEILING as weekly upside in points. Be plain and confident with no hedging filler. Use ONLY ' +
    'the numbers provided — do NOT invent injuries, specific opponents, depth-chart or coaching details, or ' +
    'anything not given. If a signal is absent, do not mention it. Output only the note, no preamble.',

  user: (s) => {
    const where = [s.pos, s.team].filter(Boolean).join(', ');
    const posRank = s.posRank ? `${s.pos}${s.posRank}` : null;
    const lines = [`Player: ${s.name}${where ? ` (${where})` : ''}`];
    lines.push(`Rank: ${posRank ? `${posRank} · ` : ''}overall #${s.rank ?? '—'}`);
    lines.push(s.inSeason
      ? `Context: in-season${s.games != null ? `, ${s.games} games played` : ''}`
      : 'Context: offseason — projecting the upcoming season');
    if (s.projPts != null) lines.push(`Projected PPR points (season): ${s.projPts}`);
    if (s.consistency != null) lines.push(`Consistency: ${s.consistency}/100 (floor vs a typical week)`);
    if (s.ceiling != null) lines.push(`Ceiling: ${s.ceiling} pts (weekly upside)`);
    if (s.form) lines.push(`Recent form: ${s.form.state.toUpperCase()}${s.form.reason ? ` — ${s.form.reason}` : ''}`);
    if (s.opportunity && s.opportunity.label) lines.push(`Opportunity: ${s.opportunity.label}`);
    const stats = s.stats.map((x) => `${x.label} ${x.value}`).join(', ');
    if (stats) lines.push(`Season stat line: ${stats}`);
    return lines.join('\n');
  },
};

// --- MLB (Phase 2) ------------------------------------------------------------
// Roto/category-framed and hitter/pitcher aware. Its differentiator is the DAY-OF matchup: for a hitter
// facing a named probable starter today, the endpoint passes ctx.bvp = { oppSp, line, advice } (from
// enrichBvp / bvpAdvice) and the note becomes a start/sit read for today's game. The provided advice
// already encodes the sample-size rules (stars start regardless; <3 AB is no signal → fall back to
// form/season), so the prompt is told to respect it rather than re-derive from the raw line. Pitchers
// get no BvP (it's batter-vs-pitcher) — their note is season value + form. Off-day/offseason (no ctx.bvp)
// → season value + form for everyone.
const MLB_PITCHER_POS = new Set(['SP', 'RP']);

const MLB_DEF = {
  gate: (p) => !!p && !p.searchOnly && p.rank != null,

  signals: (p, ctx = {}) => {
    const pitcher = MLB_PITCHER_POS.has(p.pos);
    const bvp = (!pitcher && ctx.bvp) ? ctx.bvp : null; // BvP is hitter-only, and only when built for today
    return {
      name: p.name,
      kind: pitcher ? 'pitcher' : 'hitter',
      pos: p.pos && p.pos !== '—' ? p.pos : null,
      team: p.team && p.team !== '—' ? p.team : null,
      rank: p.rank ?? null,
      form: (p.tag === 'hot' || p.tag === 'cold') ? { state: p.tag, reason: p.formReason || null } : null,
      stats: statLine(p),
      matchup: bvp && bvp.oppSp ? {
        oppSp: bvp.oppSp.name || null,
        line: bvp.line ? { ab: bvp.line.ab, h: bvp.line.h, hr: bvp.line.hr, avg: bvp.line.avg, ops: bvp.line.ops } : null,
        call: bvp.advice?.call || null,       // start | sit | neutral (already sample-size-aware)
        reason: bvp.advice?.reason || null,
      } : null,
    };
  },

  // Rank tier + form as usual, plus the day-of matchup IDENTITY (opponent + start/sit call). Regenerate
  // when the opponent or call changes; absent on off-days so a season-value note stays cached across days
  // rather than churning daily. Raw category totals are excluded (they tick each game).
  fp: (s) => ({
    tier: Math.ceil((s.rank || 999) / 5),
    form: s.form?.state || null,
    reason: s.form?.reason || null,
    mu: s.matchup ? `${s.matchup.oppSp || '-'}:${s.matchup.call || '-'}` : null,
  }),

  system:
    'You write terse fantasy-baseball player notes in the style of RotoWire updates, for a roto/category ' +
    'manager. Write 2-3 sentences, present tense. Read the standard category line (hitters: AVG/HR/RBI/R/SB/OBP; ' +
    'pitchers: K/W/SV/HD/ERA/WHIP) for what the player provides, and weigh any HOT/COLD recent form. If a ' +
    'TODAY\'S MATCHUP is provided (a hitter facing a named probable starter), give a start/sit call for today: ' +
    'the provided matchup read already accounts for sample size, so when it says the history is thin or no ' +
    'signal, lean on recent form and season value instead of the batter-vs-pitcher line. Be plain and confident ' +
    'with no hedging filler. Use ONLY the data provided — do NOT invent injuries, ballparks, weather, handedness, ' +
    'lineup spot, or anything not given. Output only the note, no preamble.',

  user: (s) => {
    const where = [s.pos, s.team].filter(Boolean).join(', ');
    const lines = [
      `Player: ${s.name}${where ? ` (${where})` : ''} — ${s.kind}`,
      `Roto rank: #${s.rank ?? '—'}`,
    ];
    if (s.form) lines.push(`Recent form: ${s.form.state.toUpperCase()}${s.form.reason ? ` — ${s.form.reason}` : ''}`);
    const stats = s.stats.map((x) => `${x.label} ${x.value}`).join(', ');
    if (stats) lines.push(`Season line: ${stats}`);
    if (s.matchup) {
      const L = s.matchup.line;
      const hist = L && L.ab > 0
        ? `career ${L.h}-for-${L.ab}${L.avg != null ? `, ${L.avg}` : ''}${L.ops != null ? `/${L.ops} OPS` : ''}${L.hr ? `, ${L.hr} HR` : ''}`
        : (L && L.ab === 0 ? 'no career history (first matchup)' : 'no BvP data');
      lines.push(`Today's matchup: faces ${s.matchup.oppSp || 'TBD'} — ${hist}`);
      if (s.matchup.call) lines.push(`Matchup read: ${s.matchup.call.toUpperCase()}${s.matchup.reason ? ` — ${s.matchup.reason}` : ''}`);
    }
    return lines.join('\n');
  },
};

// --- NHL (Phase 5) ------------------------------------------------------------
// Roto/category-framed, skater/goalie aware. Its differentiator is the DAY-OF opponent-defense matchup
// (nhlMatchup.js): for a SKATER with a game today, the endpoint passes ctx.nhlMatchup = { opp, oppGaRank,
// oppPkRank, lean, reason } — the note factors in whether tonight's opponent is a soft or elite defense.
// Goalies get season value + form only: their matchup hinges on being the confirmed starter, which the
// free API doesn't reliably expose pre-game, so that piece is DEFERRED. Off-day / offseason (no ctx) →
// season value + form for everyone.
const NHL_GOALIE_POS = new Set(['G']);

const NHL_DEF = {
  gate: (p) => !!p && !p.searchOnly && p.rank != null,

  signals: (p, ctx = {}) => {
    const goalie = NHL_GOALIE_POS.has((p.pos || '').toUpperCase());
    const mu = (!goalie && ctx.nhlMatchup) ? ctx.nhlMatchup : null; // opponent-defense matchup is for skaters
    return {
      name: p.name,
      kind: goalie ? 'goalie' : 'skater',
      pos: p.pos && p.pos !== '—' ? p.pos : null,
      team: p.team && p.team !== '—' ? p.team : null,
      rank: p.rank ?? null,
      form: (p.tag === 'hot' || p.tag === 'cold') ? { state: p.tag, reason: p.formReason || null } : null,
      stats: statLine(p),
      matchup: mu ? {
        opp: mu.opp?.abbrev || null, isHome: !!mu.isHome,
        lean: mu.lean || null, reason: mu.reason || null,
      } : null,
    };
  },

  // Rank tier + form, plus the day-of matchup identity (opponent + lean). Regenerate when the opponent or
  // lean changes; absent on off-days so a season-value note stays cached. Raw category totals excluded.
  fp: (s) => ({
    tier: Math.ceil((s.rank || 999) / 5),
    form: s.form?.state || null,
    reason: s.form?.reason || null,
    mu: s.matchup ? `${s.matchup.opp || '-'}:${s.matchup.lean || '-'}` : null,
  }),

  system:
    'You write terse fantasy-hockey player notes in the style of RotoWire updates, for a roto/category ' +
    'manager. Write 2-3 sentences, present tense. Read the standard category line (skaters: G/A/PTS/+-/SOG/PPP; ' +
    'goalies: W/GAA/SV%/SO/SV/SA) for what the player provides, and weigh any HOT/COLD form. If a TONIGHT\'S ' +
    'MATCHUP is provided (a skater\'s opponent-defense read — favorable, tough, or neutral), factor it into a ' +
    'start/stream call for tonight. Be plain and confident with no hedging filler. Use ONLY the data provided — ' +
    'do NOT invent injuries, line or power-play-unit assignments, or a confirmed starting goalie (starters are ' +
    'not provided). Output only the note, no preamble.',

  user: (s) => {
    const where = [s.pos, s.team].filter(Boolean).join(', ');
    const lines = [
      `Player: ${s.name}${where ? ` (${where})` : ''} — ${s.kind}`,
      `Roto rank: #${s.rank ?? '—'}`,
    ];
    if (s.form) lines.push(`Recent form: ${s.form.state.toUpperCase()}${s.form.reason ? ` — ${s.form.reason}` : ''}`);
    const stats = s.stats.map((x) => `${x.label} ${x.value}`).join(', ');
    if (stats) lines.push(`Season line: ${stats}`);
    if (s.matchup) {
      lines.push(`Tonight's matchup (${s.matchup.lean || 'neutral'}): ${s.matchup.reason || (s.matchup.opp ? `${s.matchup.isHome ? 'vs' : '@'} ${s.matchup.opp}` : '')}`);
    }
    return lines.join('\n');
  },
};

// Registry — the built-in specialized sports.
const REGISTRY = { nfl: NFL_DEF, mlb: MLB_DEF, nhl: NHL_DEF };

// Public: register a sport's specialized def (used by the sport phases; exported for testability).
export function registerSport(sport, def) { REGISTRY[sport] = def; }

// Resolve the def for a sport, falling back to the generic one.
export function synopsisDef(sport) { return REGISTRY[sport] || GENERIC; }

// Pure preparation: gate + signals + fingerprint + prompt for a player, with no I/O. The endpoint (and
// tests) call this; keeping it side-effect-free means the fingerprint and prompt are unit-testable
// without KV or the network.
export function prepare(sport, player, ctx = {}) {
  const def = synopsisDef(sport);
  if (!def.gate(player, ctx)) return { relevant: false, reason: 'not_relevant' };
  const signals = def.signals(player, ctx);
  return {
    relevant: true,
    signals,
    fp: fingerprint({ sport, ...def.fp(signals) }),
    system: def.system,
    user: def.user(signals),
  };
}

// --- orchestrator -------------------------------------------------------------
// On-demand, cache-aware. Returns one of:
//   { text, generatedAt, cached:true }              cache hit (fingerprint unchanged)
//   { text, generatedAt, cached:false }             freshly generated + cached
//   { text, generatedAt, cached:true, stale:true }  generation failed but a prior note exists
//   { text:null, reason }                           not relevant / disabled / generation failed, no prior
export async function getPlayerSynopsis({ sport, player, ctx = {} }) {
  const prep = prepare(sport, player, ctx);
  if (!prep.relevant) return { text: null, reason: prep.reason };

  const id = player.id ?? player.rank ?? player.name;
  const cacheKey = synopsisKey(sport, id);
  let cached = null;
  try { cached = await redis.get(cacheKey); } catch { cached = null; }
  if (cached && cached.fp === prep.fp && cached.text) {
    return { text: cached.text, generatedAt: cached.generatedAt, cached: true };
  }

  const text = await generateText(prep.system, prep.user);
  if (!text) {
    if (cached?.text) return { text: cached.text, generatedAt: cached.generatedAt, cached: true, stale: true };
    return { text: null, reason: process.env.ANTHROPIC_API_KEY ? 'generation_failed' : 'disabled' };
  }

  const rec = { fp: prep.fp, text, generatedAt: new Date().toISOString(), model: MODEL };
  try { await redis.set(cacheKey, rec); } catch { /* cache write best-effort */ }
  return { text, generatedAt: rec.generatedAt, cached: false };
}
