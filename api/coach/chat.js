// AI Coach chat endpoint (Premium only). Forwards the running conversation to Claude
// with a fantasy-sports-friend system prompt and returns one reply. Stateless: the
// client sends the full message history each turn, and we cap/clamp it to bound cost.
//
// Uses the Anthropic Messages API via raw fetch (matching the app's other Claude call
// sites — synopsis.js, draft/advise.js — which avoids adding an SDK to this no-build
// serverless app). Model is claude-opus-4-8; thinking is left off for snappy chat
// replies, so the system prompt tells it to answer directly without reasoning preamble.
import { requirePremium, sendError } from '../_lib/auth.js';
import { buildLiveContext } from '../_lib/coachContext.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-4-8';
const MAX_TURNS = 20;      // forward at most the last ~10 exchanges
const MAX_CHARS = 4000;    // clamp any single message so one paste can't blow the budget
const MAX_CONTEXT = 4000;  // clamp the optional draft-state context the same way

// An Opus reply at 1024 tokens can take ~10-20s; raise above the 10s Hobby default so
// the response isn't cut off mid-stream. (Vercel Hobby caps at 60s.)
export const maxDuration = 60;

const SYSTEM = `You are the FantasyEdge AI Coach — a sharp, friendly fantasy sports expert who talks like a knowledgeable buddy who happens to be great at fantasy. You help across all major fantasy sports: NFL, MLB, NBA, NHL, WNBA, and PGA (fantasy golf / DFS).

What you help with:
- Trades: who wins a deal, whether to accept/counter, buy-low / sell-high angles.
- Start/sit: which player to play this week and the reasoning.
- Waiver wire: pickups worth a claim, FAAB guidance, who to drop.
- Draft: pick advice, value vs. ADP, roster construction, sleepers.

How to talk:
- Be conversational and concise — like texting a friend who knows ball. A few tight sentences usually beats an essay. Use the player's names naturally.
- Give a clear recommendation, not a wishy-washy "it depends." If it genuinely depends, say what it depends on, then make the call you'd make.
- When league format matters (PPR vs standard, roto vs points, dynasty vs redraft, league size, scoring categories) and the user hasn't said, make a sensible assumption, state it in one breath, and ask a quick follow-up if it would change your answer.
- Light, encouraging tone is great. Skip the corporate hedging.

Sport quirks:
- Golf (PGA) has no trades. If someone frames a question about golfers as a "trade" (e.g. "should I trade Scheffler for Rahm?"), don't treat it like a roster trade — they almost always mean a fantasy-golf decision: who to pick for their golf pool, who to roster in a DFS lineup, or who to start this week. Reframe it as a "who has more value this week / who would you pick" call and answer that directly. A quick "golf doesn't really do trades, but here's who I'd ride this week" is the right move — don't lecture them about it.

Honesty rules (important):
- Your knowledge has a cutoff, so you may not know this week's exact injuries, weather, depth-chart moves, or who's on a hot streak right now. Don't invent specific injuries, stats, transactions, or news you can't be sure of. When a call hinges on up-to-the-minute info, say so plainly and give the user the framework to decide (and ask them what they're seeing).
- Reason from process — roles, talent, matchups, usage, scoring — rather than fabricating precise numbers.

Format: respond with your final answer only — no preamble, no "let me think", no bullet-point lists unless the user asks for a list. Just talk to them.`;

// Keep only valid user/assistant text turns, clamp length, cap count, and make sure
// the history starts on a user turn (the API requires the first message be 'user').
function sanitize(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw) {
    const role = m && (m.role === 'user' || m.role === 'assistant') ? m.role : null;
    const content = typeof m?.content === 'string' ? m.content.trim() : '';
    if (!role || !content) continue;
    out.push({ role, content: content.slice(0, MAX_CHARS) });
  }
  const trimmed = out.slice(-MAX_TURNS);
  while (trimmed.length && trimmed[0].role !== 'user') trimmed.shift();
  return trimmed;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Premium-only — re-verify the Clerk session + plan server-side (the UI gate is cosmetic).
    await requirePremium(req);

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(503).json({ error: 'The Coach is unavailable right now.' });

    const messages = sanitize(req.body?.messages);
    if (!messages.length) return res.status(400).json({ error: 'Say something to the Coach first.' });

    // Ground the reply in live FantasyEdge data from KV for any players/sport the user
    // mentioned. Failure-tolerant — if it throws or finds nothing, we send the base prompt.
    let system = SYSTEM;
    try {
      const live = await buildLiveContext(messages);
      if (live) system += '\n\n' + live;
    } catch (err) {
      console.error('[coach] live context failed', err?.message);
    }

    // Optional live draft state, sent when the Coach is embedded in the draft room.
    // Gives it the user's roster, recent picks, and top targets so its advice is
    // grounded in the draft in progress. Absent on the standalone Coach page.
    const draftContext = typeof req.body?.draftContext === 'string' ? req.body.draftContext.trim() : '';
    if (draftContext) {
      system += '\n\nLIVE DRAFT IN PROGRESS — the user is drafting right now. Use this to ground your advice; '
        + 'favor it over training knowledge and don\'t recite it back verbatim:\n' + draftContext.slice(0, MAX_CONTEXT);
    }

    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, messages }),
    });
    if (!r.ok) {
      console.error('[coach] Anthropic error', r.status, await r.text().catch(() => ''));
      return res.status(502).json({ error: 'The Coach had trouble responding — give it another shot.' });
    }
    const j = await r.json();
    const reply = (j?.content?.find((b) => b.type === 'text')?.text || '').trim();
    if (!reply) return res.status(502).json({ error: 'The Coach came up empty — try rephrasing.' });

    return res.json({ reply });
  } catch (err) {
    return sendError(res, err);
  }
}
