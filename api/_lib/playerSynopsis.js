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

// Registry — Phase 1 (nfl) and Phase 2 (mlb) will register specialized defs here.
const REGISTRY = { /* nfl: {...}, mlb: {...} */ };

// Public: register a sport's specialized def (used by the sport phases; exported for testability).
export function registerSport(sport, def) { REGISTRY[sport] = def; }

// Resolve the def for a sport, falling back to the generic one.
export function synopsisDef(sport) { return REGISTRY[sport] || GENERIC; }

// Pure preparation: gate + signals + fingerprint + prompt for a player, with no I/O. The endpoint (and
// tests) call this; keeping it side-effect-free means the fingerprint and prompt are unit-testable
// without KV or the network.
export function prepare(sport, player, ctx = {}) {
  const def = synopsisDef(sport);
  if (!def.gate(player)) return { relevant: false, reason: 'not_relevant' };
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
