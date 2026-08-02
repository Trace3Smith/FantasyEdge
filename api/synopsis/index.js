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
  redis, DATASET_KEY, NBA_DATASET_KEY, WNBA_DATASET_KEY, NHL_DATASET_KEY, NFL_DATASET_KEY, PGA_DATASET_KEY, BVP_KEY,
} from '../_lib/kv.js';
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

    const ctx = { builtAt: dataset?.builtAt || null, bvp: null, posRank };
    if (sport === 'mlb') {
      const b = await redis.get(BVP_KEY);
      if (b && b.date === today()) ctx.bvp = b.batters?.[player.id] || null;
    }

    const out = await getPlayerSynopsis({ sport, player, ctx });
    return res.json(out);
  } catch (err) {
    return res.status(500).json({ error: err.message, text: null });
  }
}
