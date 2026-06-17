// Draft-pick advice: algorithmic best-available candidates (api/_lib/draft.js) plus
// one short Claude rationale for the top pick. Free users get advice through round 7
// (FREE_MAX_ROUND); later rounds return an upsell. Premium gets every round.
import { getEntitlement, sendError, HttpError, FREE_MAX_ROUND } from '../_lib/auth.js';
import { loadPlayers, recommend, DEFAULT_SETTINGS } from '../_lib/draft.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const SYSTEM = `You are a sharp fantasy football draft assistant. You are given the drafter's current roster, the round, the top available players (with value-over-replacement and positional-need flags), and THE recommended pick — already selected by our model. In 2 concise sentences, explain why that recommended pick is the right selection, citing positional need, value/VORP, or a position run. Do NOT suggest or name a different player; justify the recommended pick. No preamble, no lists — just the advice.`;

// Ask Claude for a one-line rationale on the recommendation. Returns null on any
// failure (no key, API error) so the algorithmic candidates still ship.
async function rationaleFor({ round, roster, candidates, runs, scoring }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !candidates.length) return null;
  const rosterStr = roster.length ? roster.map((r) => r.pos).join(', ') : '(empty)';
  // The header shows candidates[0]; pin Claude's rationale to that exact player so the
  // explanation can never argue for a different name than the one on screen.
  const pick = candidates[0];
  const top = candidates
    .slice(0, 6)
    .map((c) => `${c.name} (${c.pos}, ${c.team}) value ${c.value}, VORP ${c.vorp}${c.need ? ', NEED' : ''}`)
    .join('\n');
  const prompt = `Round ${round}, ${scoring.toUpperCase()} scoring.\nMy roster so far: ${rosterStr}.\n${runs.length ? `Recent run on: ${runs.join(', ')}.\n` : ''}Top available:\n${top}\n\nRecommended pick: ${pick.name} (${pick.pos}, ${pick.team}). Explain why this is the right pick.`;
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 160,
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.content?.[0]?.text?.trim() || null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { premium } = await getEntitlement(req);
    const b = req.body || {};
    const round = Number(b.round) || 1;

    // Free-tier round gate — later rounds are premium-only.
    if (!premium && round > FREE_MAX_ROUND) {
      throw new HttpError(403, 'Upgrade for full-draft advice', {
        error: 'round_locked',
        upsell: true,
        freeMaxRound: FREE_MAX_ROUND,
      });
    }

    // League size is a basic setting honored for all tiers (it drives the draft
    // mechanics + ADP scaling); scoring/rounds stay premium-only, matching mock-start.
    const o = b.settings || {};
    const settings = { ...DEFAULT_SETTINGS };
    if ([8, 10, 12, 14].includes(Number(o.teams))) settings.teams = Number(o.teams);
    if (premium) {
      if (o.scoring === 'standard' || o.scoring === 'ppr') settings.scoring = o.scoring;
      if (Number.isInteger(o.rounds) && o.rounds >= 10 && o.rounds <= 20) settings.rounds = o.rounds;
    }
    const players = await loadPlayers(b.sport || 'nfl');
    const roster = Array.isArray(b.roster) ? b.roster : [];
    const { candidates, runs } = recommend(players, b.drafted || [], roster, settings, round, b.recentPicks || []);

    const rationale = await rationaleFor({ round, roster, candidates, runs, scoring: settings.scoring });

    return res.json({ candidates, runs, rationale, round, premium });
  } catch (err) {
    return sendError(res, err);
  }
}
