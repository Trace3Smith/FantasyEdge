// Player-synopsis endpoint (Phase 0). POST { sport, playerId } -> { text, generatedAt, cached } or
// { text:null, reason }. Reads the player's CURRENT row from the same daily KV dataset the rankings
// tab serves, then delegates to the shared engine (on-demand generation + fingerprint cache).
//
// PREMIUM-GATED: this spends Anthropic tokens on generation, so it re-verifies the Clerk session +
// plan server-side (the UI control is cosmetic), exactly like the other paid endpoints. Easy to relax
// to free-with-rate-limit later if we decide to — the gate is the only line that would change.
//
// Failure-tolerant: an unknown sport 400s, a missing player 404s, and any downstream failure returns
// a null note (200) so the rankings page degrades to "no report" rather than erroring.
import { requirePremium, sendError } from '../_lib/auth.js';
import {
  redis, DATASET_KEY, NBA_DATASET_KEY, WNBA_DATASET_KEY, NHL_DATASET_KEY, NFL_DATASET_KEY, PGA_DATASET_KEY,
  BVP_KEY, NHL_MATCHUP_KEY, NBA_MATCHUP_KEY, WNBA_MATCHUP_KEY, NFL_DVP_KEY,
} from '../_lib/kv.js';
import { dvpMatchup } from '../_lib/nflDvp.js';

// Per-league day-of matchup keys for the basketball leagues.
const HOOPS_MATCHUP_KEY = { nba: NBA_MATCHUP_KEY, wnba: WNBA_MATCHUP_KEY };
// NFL position → defense-vs-position group: RBs care about rush D, WR/TE/QB about pass D.
const NFL_DVP_GROUP = { RB: 'rush', WR: 'pass', TE: 'pass', QB: 'pass' };
import { getPlayerSynopsis } from '../_lib/playerSynopsis.js';

// Same sport -> dataset-key map the Coach uses, so the synopsis reads exactly what the rankings show.
const KEYS = {
  nfl: NFL_DATASET_KEY,
  mlb: DATASET_KEY,
  nba: NBA_DATASET_KEY,
  wnba: WNBA_DATASET_KEY,
  nhl: NHL_DATASET_KEY,
  pga: PGA_DATASET_KEY,
};

const today = () => new Date().toISOString().slice(0, 10);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Trust boundary: verify session + premium before spending any tokens.
  try {
    await requirePremium(req);
  } catch (err) {
    return sendError(res, err);
  }

  const { sport, playerId } = req.body || {};
  const key = KEYS[sport];
  if (!key) return res.status(400).json({ error: 'unknown sport' });
  if (playerId == null) return res.status(400).json({ error: 'playerId required' });

  try {
    const dataset = await redis.get(key);
    const players = dataset?.players || [];
    const player = players.find((p) => String(p.id) === String(playerId));
    if (!player) return res.status(404).json({ error: 'player not found' });

    // Forward-compatible context. Phase 0's generic def ignores it; Phase 2 (MLB) reads ctx.bvp for the
    // day-of batter-vs-pitcher matchup. Load BvP only for MLB, and only if it was built for today, so a
    // stale slate never feeds the note.
    // Positional rank (e.g. WR3) among rosterable same-position players by value — NFL framing uses it;
    // other sports' defs ignore it. Cheap to compute here where the full dataset is in hand.
    let posRank = null;
    if (player.pos && player.pos !== '—') {
      const peers = players
        .filter((q) => !q.searchOnly && q.pos === player.pos)
        .sort((a, b) => (b.fpPpr ?? b.fp ?? b.zTotal ?? 0) - (a.fpPpr ?? a.fp ?? a.zTotal ?? 0));
      const i = peers.findIndex((q) => String(q.id) === String(player.id));
      if (i >= 0) posRank = i + 1;
    }

    const ctx = { builtAt: dataset?.builtAt || null, bvp: null, nhlMatchup: null, hoopsMatchup: null, nflDvp: null, posRank };
    if (sport === 'nfl') {
      // Position-relevant defense-vs-position for this week's opponent (in-season only — the DvP payload is
      // empty out of season, so this naturally doesn't fire in the offseason draft framing). Phrased here
      // because the pass-vs-rush split depends on the player's position; the def just renders it.
      const group = NFL_DVP_GROUP[(player.pos || '').toUpperCase()];
      if (group) {
        const d = await redis.get(NFL_DVP_KEY);
        const entry = d?.teams?.[player.team];
        const mu = entry ? dvpMatchup(entry, group) : null;
        if (mu) ctx.nflDvp = { ...mu, opp: entry.opp?.abbrev || null, isHome: !!entry.isHome };
      }
    }
    if (sport === 'mlb') {
      const b = await redis.get(BVP_KEY);
      if (b && b.date === today()) ctx.bvp = b.batters?.[player.id] || null;
    } else if (sport === 'nhl') {
      // Day-of opponent-defense matchup for the player's team (skaters; the def suppresses it for goalies).
      // Only when built for today, so a stale slate never shows.
      const m = await redis.get(NHL_MATCHUP_KEY);
      if (m && m.date === today() && player.team) ctx.nhlMatchup = m.teams?.[player.team] || null;
    } else if (sport === 'nba' || sport === 'wnba') {
      // Day-of opponent pace + defense matchup for the player's team. Only when built for today.
      const m = await redis.get(HOOPS_MATCHUP_KEY[sport]);
      if (m && m.date === today() && player.team) ctx.hoopsMatchup = m.teams?.[player.team] || null;
    }

    const out = await getPlayerSynopsis({ sport, player, ctx });
    return res.json(out);
  } catch (err) {
    return res.status(500).json({ error: err.message, text: null });
  }
}
