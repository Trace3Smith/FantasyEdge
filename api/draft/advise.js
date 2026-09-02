// Draft-pick advice. Our model (api/_lib/draft.js) builds the shortlist of best
// available candidates with their signals (value vs. replacement, ADP/falling value,
// roster need, positional scarcity); a single Claude call then acts as the draft
// analyst and makes THE final recommendation — weighing need, value, scarcity, and
// flagging an elite player falling past his ADP as a reach. The algorithm informs
// Claude's context; Claude decides. Falls back to the model's own top pick if the
// Claude call is unavailable or returns anything unparseable, so advice always ships.
// Free users get advice through round 7 (FREE_MAX_ROUND); later rounds return an upsell.
import { getEntitlement, sendError, HttpError, FREE_MAX_ROUND } from '../_lib/auth.js';
import { loadPlayers, recommend, DEFAULT_SETTINGS, isRoto, resolveStarters, vonaScarcityClause, vonaScarcityPromptNote, scarcityLine } from '../_lib/draft.js';
import { NBA_CATS } from '../../nbaScoring.js';
import { MLB_CATS } from '../../mlbScoring.js';
import { NHL_CATS } from '../../nhlScoring.js';
import { adpFitPhrase } from '../../pickReasons.js';
import { teamOnClock, picksUntilNextTurn } from '../../draftOrder.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const SYSTEM_NFL = `You are an elite fantasy football draft analyst. The user is on the clock and you make ONE decisive pick recommendation. Balance four things:
1. Team needs — what the roster is missing (unfilled starting slots first, then useful depth and the FLEX). The prompt lists the STARTING slots as FILLED vs STILL OPEN — trust it exactly: a FILLED slot is done, so never tell the user to draft or "still need" that position as a starter (extra bodies there are depth, not a need), and only a STILL OPEN slot is a real starting need.
2. Best player available vs. ADP — a strong player still on the board well past his average draft position (ADP) is falling value worth pouncing on.
3. Positional scarcity — as startable players at a position dry up while the draft progresses, urgency to secure one rises.
4. Need vs. value balance — usually take the best value that also fits a need, but when an ELITE player is falling well past his ADP it can be worth reaching even if his position isn't a current need. When you recommend that, set reach=true.

FLEX / EXTRA TE RULE: the FLEX takes any RB/WR/TE, so who fills it best is decided by projected OUTPUT there, not by position. Once the user already has their starting TE, a 2nd TE only ever plays via the flex — so take one over an available RB/WR ONLY if it out-projects them; if it merely ties or trails, the RB/WR is the better pick (they also cover byes/injuries). A candidate flagged "extra TE — bench only" has already failed that test: do NOT recommend it over a comparable RB/WR.

ROSTER NECESSITY OVERRIDE: if the prompt includes a ROSTER NECESSITY note, it overrides everything above — you MUST use this pick to fill one of the named mandatory slots (typically K or DST in the final rounds). An incomplete, illegal lineup is worse than any value you could gain, so take the mandatory slot now rather than a falling-value reach, and set reach=false.

You are given the roster, round, scoring, recent positional runs, positional scarcity, and a numbered shortlist of the best available candidates (already filtered by our model) with each one's signals — including where given a consistency score (weekly floor, out of 100; higher = steadier) and a points ceiling (weekly upside). Favor a steady floor when locking a starter you need every week, and tolerate a lower floor for a high ceiling on an upside swing. Pick THE single best candidate from that shortlist. You may deviate from board order when need, scarcity, or falling value justifies it.

Each candidate's ADP fit is given to you explicitly (e.g. "still on the board N picks past his ADP", "being taken N picks ahead of his ADP", or "right around his ADP"). Use ONLY that provided figure when you talk about ADP — do NOT compute or invent your own "picks past ADP" or "rounds past ADP" numbers, and never claim a player is past his ADP unless the line says so.

When the prompt includes a SCARCITY TRADEOFF note, you are deliberately prioritizing a scarcer position over the highest raw-value name still on the board: your rationale MUST explain WHY that tradeoff is worth it (the scarcer position is drying up faster and you can still get comparable value at the deeper position later). Do NOT restate the raw startable counts — they are surfaced to the user separately.

Respond with ONLY a JSON object — no prose, no markdown fences:
{"pick": <candidate number>, "rationale": "<2-3 conversational sentences like a sharp friend; speak in projected points, ADP value, roster fit and scarcity; NEVER mention internal jargon like VORP, value-over-replacement, or a 'score'>", "reach": <true only if you are recommending reaching for a falling elite player ahead of a positional need, else false>}`;

const SYSTEM_NBA = `You are an elite fantasy basketball draft analyst for a standard 9-category roto league (PTS, REB, AST, STL, BLK, 3PM, TO, FG%, FT%). The user is on the clock and you make ONE decisive pick recommendation. Balance four things:
1. Category balance — a roto team wins by being competitive across categories, not by stacking one. Favor players who shore up the categories the roster is currently WEAK in; don't pile onto a category you've already locked up.
2. Best player available — total all-around category value is the baseline; a clearly superior multi-cat player is worth taking even when his strengths overlap what you have.
3. Roster slots — you must end with a legal lineup (PG/SG/SF/PF/C/G/F/UTIL). Fill open starting slots, leaning on positional flexibility (G/F/UTIL) to stay flexible.
4. Percentage cats — FG% and FT% are volume-weighted: an efficient high-usage scorer lifts them, while a high-volume poor free-throw shooter (often a center) actively drags down your FT%. Weigh that against his counting stats.

ROSTER NECESSITY OVERRIDE: if the prompt includes a ROSTER NECESSITY note, it overrides everything above — you MUST use this pick to fill one of the named open starting slots. An incomplete, illegal lineup is worse than any category edge, so take the slot now and set reach=false.

You are given the roster, round, your currently weak categories, positional scarcity, recent runs, and a numbered shortlist of the best available candidates (already filtered by our model) with each one's category profile. Pick THE single best candidate from that shortlist. You may deviate from board order when category need or roster need justifies it.

Respond with ONLY a JSON object — no prose, no markdown fences:
{"pick": <candidate number>, "rationale": "<2-3 conversational sentences like a sharp friend; speak in categories, roster balance, and which cats this player wins or punts; NEVER mention internal jargon like z-score or a 'score'>", "reach": <true only if you are reaching for a clearly superior all-around player ahead of a slot or category need, else false>}`;

const SYSTEM_MLB = `You are an elite fantasy baseball draft analyst for a standard mixed roto league. Hitters score on R, HR, RBI, SB, AVG and OBP; pitchers on W, SV, K, ERA and WHIP. The user is on the clock and you make ONE decisive pick recommendation. Balance four things:
1. Category balance — a roto team wins by being competitive across all categories on both sides (hitting and pitching), not by stacking one. Favor players who shore up categories the roster is currently WEAK in; once your bats are stocked, pivot to pitching (and vice-versa).
2. Best player available — total all-around category value is the baseline; a clearly superior multi-cat player is worth taking even when his strengths overlap what you have.
3. Roster slots — you must end with a legal lineup (C, 1B, 2B, 3B, SS, OF, UTIL, SP, RP). Fill open starting slots, leaning on UTIL flexibility to stay flexible.
4. Rate vs. counting cats — AVG/OBP and ERA/WHIP are ratios: a high-volume regular moves them more than a part-timer, and an inefficient pitcher with lots of innings actively drags down your ERA/WHIP. Weigh that against the counting stats.

ROSTER NECESSITY OVERRIDE: if the prompt includes a ROSTER NECESSITY note, it overrides everything above — you MUST use this pick to fill one of the named open starting slots. An incomplete, illegal lineup is worse than any category edge, so take the slot now and set reach=false.

You are given the roster, round, your currently weak categories, positional scarcity, recent runs, and a numbered shortlist of the best available candidates (already filtered by our model) with each one's stat line and category profile. Pick THE single best candidate from that shortlist. You may deviate from board order when category need or roster need justifies it.

Respond with ONLY a JSON object — no prose, no markdown fences:
{"pick": <candidate number>, "rationale": "<2-3 conversational sentences like a sharp friend; speak in categories, roster balance, and which cats this player wins; NEVER mention internal jargon like z-score or a 'score'>", "reach": <true only if you are reaching for a clearly superior all-around player ahead of a slot or category need, else false>}`;

const SYSTEM_NHL = `You are an elite fantasy hockey draft analyst for a standard roto league. Skaters score on G, A, +/-, PIM, PPP, SOG, FOW and GWG; goalies on W, GAA, SV%, SO and saves. The user is on the clock and you make ONE decisive pick recommendation. Balance four things:
1. Category balance — a roto team wins by being competitive across categories, not by stacking one. Favor players who shore up the categories the roster is currently WEAK in; don't pile onto a category you've already locked up.
2. Best player available — total all-around category value is the baseline; a clearly superior multi-cat player is worth taking even when his strengths overlap what you have.
3. Roster slots — you must end with a legal lineup (C, LW, RW, D, G). Fill open starting slots, and remember goalie wins/ratios are scarce and worth securing.
4. Goalies vs. skaters — a roster of pure skaters punts every goalie category. Make sure you draft enough goalies to compete in W/GAA/SV%/SO, but don't reach for a shaky starter.

ROSTER NECESSITY OVERRIDE: if the prompt includes a ROSTER NECESSITY note, it overrides everything above — you MUST use this pick to fill one of the named open starting slots. An incomplete, illegal lineup is worse than any category edge, so take the slot now and set reach=false.

You are given the roster, round, your currently weak categories, positional scarcity, recent runs, and a numbered shortlist of the best available candidates (already filtered by our model) with each one's stat line and category profile. Pick THE single best candidate from that shortlist. You may deviate from board order when category need or roster need justifies it.

Respond with ONLY a JSON object — no prose, no markdown fences:
{"pick": <candidate number>, "rationale": "<2-3 conversational sentences like a sharp friend; speak in categories, roster balance, and which cats this player wins; NEVER mention internal jargon like z-score or a 'score'>", "reach": <true only if you are reaching for a clearly superior all-around player ahead of a slot or category need, else false>}`;

const isNba = (sport) => sport === 'nba' || sport === 'wnba';
function systemFor(sport) {
  if (isNba(sport)) return SYSTEM_NBA;
  if (sport === 'mlb') return SYSTEM_MLB;
  if (sport === 'nhl') return SYSTEM_NHL;
  return SYSTEM_NFL;
}

const fmt1 = (v) => (v == null ? '—' : (Math.round(v * 10) / 10).toFixed(1));
const pct3 = (v) => (v == null ? '—' : '.' + String(Math.round(v * 1000)).padStart(3, '0')); // 0.55 -> ".550"

// Describe one NFL candidate for the prompt in plain terms (projected points, ADP value,
// roster need, scarcity-relevant flags) — never internal scoring metrics.
function describeNfl(c, n, teams) {
  const bits = [`[${n}] ${c.name} (${c.pos}, ${c.team})`, `board #${c.rank ?? '—'}`];
  if (c.proj != null) bits.push(`~${c.proj} projected pts`);
  if (c.adp != null) bits.push(`ADP ${c.adp}`);
  // Correct, two-directional ADP fit from the model's signed delta (pick − ADP): positive = still available
  // past his ADP (value), negative = being taken ahead of his ADP (a reach, sized by magnitude — a full
  // round or more reads "notable", not "slight"). The analyst must use THIS, never invent its own
  // "picks/rounds past ADP" math. Wording lives in adpFitPhrase (pickReasons.js) so it stays testable and
  // consistent with the headline/board tag.
  if (c.adp != null) {
    const fit = adpFitPhrase(c.adpDelta, teams);
    if (fit) bits.push(fit);
  }
  // Fused consistency/ceiling (weekly floor vs upside) + in-season form, so the analyst can weigh a steady
  // starter against a boom-or-bust flier. Absent in the offseason / for thin players → simply omitted.
  if (c.consistency != null) bits.push(`consistency ${c.consistency}/100 (weekly floor)${c.ceiling != null ? `, ~${c.ceiling}-pt ceiling` : ''}`);
  if (c.form === 'hot') bits.push('trending up');
  if (c.need) bits.push('fills a roster need');
  if (c.forced) bits.push('mandatory starting slot still unfilled');
  // A beyond-starter TE the engine judged not flex-worthy (a better RB/WR fills the flex). Surface the
  // verdict so the analyst doesn't recommend it over a comparable RB/WR (see the FLEX / EXTRA TE RULE).
  if (typeof c.reasonLabel === 'string' && c.reasonLabel.includes('bench only')) bits.push('extra TE — bench only (a better RB/WR fills the flex)');
  return bits.join(', ');
}

// Describe one NBA candidate in category terms: real stat line + which cats he wins/hurts
// (from his per-cat z block) + roster-slot relevance. Never internal scoring metrics.
function describeNba(c, i) {
  const bits = [`[${i}] ${c.name} (${c.pos}, ${c.team})`, `board #${c.rank ?? '—'}`];
  const n = c.n;
  if (n) bits.push(`${fmt1(n.pts)}p/${fmt1(n.reb)}r/${fmt1(n.ast)}a, ${fmt1(n.tpm)} 3PM, ${fmt1(n.stl)} STL, ${fmt1(n.blk)} BLK, ${pct3(n.fgPct)} FG, ${pct3(n.ftPct)} FT, ${fmt1(n.to)} TO`);
  if (c.z) {
    const ranked = NBA_CATS.map((cat) => ({ label: cat.label, z: c.z[cat.key] || 0 })).sort((a, b) => b.z - a.z);
    const strong = ranked.filter((x) => x.z >= 0.7).slice(0, 3).map((x) => x.label);
    const weak = ranked.filter((x) => x.z <= -0.6).map((x) => x.label).slice(-2);
    if (strong.length) bits.push(`elite ${strong.join('/')}`);
    if (weak.length) bits.push(`hurts ${weak.join('/')}`);
  }
  if (c.need) bits.push('fills an open lineup slot');
  if (c.forced) bits.push('open starting slot still unfilled');
  return bits.join(', ');
}

// Describe one MLB/NHL candidate: the real stat line (from statLabels/stats) + which cats he
// wins/hurts (from his per-cat z block over the sport's categories) + roster-slot relevance.
function describeRoto(c, i, CATS) {
  const bits = [`[${i}] ${c.name} (${c.pos}, ${c.team})`, `board #${c.rank ?? '—'}`];
  if (c.statLabels && c.stats) {
    const line = c.statLabels
      .map((lab, k) => (c.stats[k] != null && c.stats[k] !== '—' ? `${c.stats[k]} ${lab}` : null))
      .filter(Boolean).join(', ');
    if (line) bits.push(line);
  }
  if (c.z) {
    const ranked = CATS.map((cat) => ({ label: cat.label, z: c.z[cat.key] || 0 })).sort((a, b) => b.z - a.z);
    const strong = ranked.filter((x) => x.z >= 0.7).slice(0, 3).map((x) => x.label);
    const weak = ranked.filter((x) => x.z <= -0.6).map((x) => x.label).slice(-2);
    if (strong.length) bits.push(`strong ${strong.join('/')}`);
    if (weak.length) bits.push(`weak ${weak.join('/')}`);
  }
  if (c.need) bits.push('fills an open lineup slot');
  if (c.forced) bits.push('open starting slot still unfilled');
  return bits.join(', ');
}

function describeFor(sport) {
  if (isNba(sport)) return describeNba;
  if (sport === 'mlb') return (c, i) => describeRoto(c, i, MLB_CATS);
  if (sport === 'nhl') return (c, i) => describeRoto(c, i, NHL_CATS);
  return describeNfl;
}

// Pull the analyst's decision out of Claude's reply. Strict + defensive: any missing
// key, out-of-range pick, or unparseable body returns null so the caller falls back to
// the model's own top candidate. `n` is the candidate count (valid picks are 1..n).
function parseAnalysis(text, n) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  const pick = Number(obj.pick);
  if (!Number.isInteger(pick) || pick < 1 || pick > n) return null;
  return {
    pick,
    rationale: typeof obj.rationale === 'string' ? obj.rationale.trim() : '',
    reach: obj.reach === true,
  };
}

// Ask Claude to make the call. Returns { pick, rationale, reach } (1-based pick index
// into `candidates`) or null on any failure (no key, API error, bad JSON).
async function analyzePick({ sport, round, scoring, teams, roster, candidates, runs, board }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !candidates.length) return null;
  const describe = describeFor(sport);
  const roto = isRoto(sport);
  const rosterStr = roster.length ? roster.map((r) => r.pos).join(', ') : '(empty)';
  // Explicit filled-vs-open STARTING slots (from the engine), so the analyst never invents a need at a
  // slot that's already filled (nor misses an open one). Bare positions alone let it miscount.
  const slots = board?.slots;
  const slotsStr = slots
    ? `\nStarting slots — FILLED (already set, NOT needs): ${slots.filled.join(', ') || 'none'}. STILL OPEN (real needs): ${slots.open.length ? slots.open.join(', ') : 'none — all starters set; anything now is depth or the FLEX'}.`
    : '';
  // Startable-left by position, fewest first — K/DST excluded (see scarcityLine) so their tiny counts
  // can't float to the front and make the analyst frame them as scarce positions needing early urgency.
  const scarcityStr = scarcityLine(board?.startableLeft);
  const listed = candidates.map((c, i) => describe(c, i + 1, teams)).join('\n');
  // Roster necessity (late draft): name the mandatory slots still open so the analyst
  // fills them instead of chasing value when there's no cushion left to wait.
  // forceNeeds = the slots that force a pick NOW (K/DST excluded until the final pick(s)); fall back to
  // needs for callers/sports without the field (roto has no kickers, so its needs already all force).
  const needPos = (board?.forceNeeds || board?.needs || []).map((n) => n.pos);
  let necessity = '';
  if (board?.mustFillNow && needPos.length) {
    necessity = `\n\nROSTER NECESSITY: only ${board.picksLeft} pick(s) left and you still MUST fill these mandatory starting slots: ${needPos.join(', ')}. `
      + `You cannot field a legal lineup without them — take a candidate that fills one of these slots now, over luxury depth or a falling-value reach.`;
  } else if (board?.fillSoon && needPos.length) {
    necessity = `\n\nROSTER HEADS-UP: only ${board.picksLeft} picks left with mandatory slots still open (${needPos.join(', ')}). `
      + `Room for one more value pick, but plan to lock in ${needPos.join('/')} within your next pick or two so you don't get squeezed.`;
  } else if (board?.deferredNeeds?.length) {
    // Unfilled mandatory slots that are correctly being deferred (K/DST before the endgame). Say so
    // rather than staying silent: the roster is not yet legal, and a recommendation for more depth at
    // an already-full position reads as an oversight if nothing acknowledges the empty slots. This
    // does NOT change the ranking — taking a kicker early is still the wrong pick.
    const dp = board.deferredNeeds.map((n) => n.pos);
    necessity = `\n\nSTILL TO FILL: ${dp.join(' and ')} ${dp.length > 1 ? 'are' : 'is'} unfilled, but correctly left for the last `
      + `${Math.max(1, board.deferredNeeds.length)} pick(s) — they're replacement-level and always available, so spending an earlier pick `
      + `there costs real value. Keep taking the best board value now; acknowledge the open ${dp.join('/')} in one short clause so the user `
      + `knows it's deliberate and planned, not overlooked.`;
  }
  // Roto leagues run on categories, not a points format; surface the roster's weak categories
  // so the analyst steers toward balance instead of stacking a strength.
  const scoringLabel = isNba(sport) ? '9-CAT' : roto ? 'roto categories' : `${scoring.toUpperCase()} scoring`;
  const leagueLabel = roto ? 'category league' : 'league';
  const weakLine = roto && board?.weakCats?.length
    ? `\nMy weak categories right now: ${board.weakCats.join(', ')} (favor candidates who help these).`
    : '';
  // VONA scarcity swing (NFL): when the model's pick was decided by a positional cliff over a
  // higher-raw-value name elsewhere, hand the analyst the concrete tradeoff facts so its prose stays
  // consistent with the deterministic clause the caller prepends. Empty string when no swing fired.
  const scarcityNote = vonaScarcityPromptNote(board?.vonaSwing);
  const prompt = `Round ${round}, ${scoringLabel}, ${teams}-team ${leagueLabel}.`
    + `\nMy roster so far: ${rosterStr}.`
    + slotsStr
    + weakLine
    + `\n${runs.length ? `Recent run on: ${runs.join(', ')} (these positions are going fast).\n` : ''}`
    + `Positional scarcity — startable players left by position (fewest first): ${scarcityStr}.`
    + `\nPicks I have left: ${board?.picksLeft ?? '?'}.`
    + necessity
    + scarcityNote
    + `\n\nCandidates:\n${listed}\n\nPick the best one and respond with the JSON object only.`;
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 320,
        system: systemFor(sport),
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return parseAnalysis(j?.content?.[0]?.text || '', candidates.length);
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
    const offline = b.mode === 'offline';

    // Offline (real-league) draft tracking is a premium feature.
    if (offline && !premium) {
      throw new HttpError(403, 'Offline draft mode is Premium', { error: 'premium_required', upsell: true });
    }
    // Free-tier round gate (mock only) — later rounds are premium-only.
    if (!offline && !premium && round > FREE_MAX_ROUND) {
      throw new HttpError(403, 'Upgrade for full-draft advice', {
        error: 'round_locked',
        upsell: true,
        freeMaxRound: FREE_MAX_ROUND,
      });
    }

    // League size is a basic setting honored for all tiers (it drives the draft
    // mechanics + ADP scaling); scoring/rounds stay premium-only, matching mock-start.
    const sport = b.sport || 'nfl';
    const o = b.settings || {};
    const settings = { ...DEFAULT_SETTINGS, sport };
    if (isRoto(sport)) {
      // Roto sports are category-based with a shorter default draft and their own lineup
      // (handled in each scoring module); there's no PPR/Standard toggle, so the points-format
      // override below never applies.
      settings.scoring = isNba(sport) ? '9cat' : 'roto';
      settings.rounds = 13;
    }
    if ([8, 10, 12, 14].includes(Number(o.teams))) settings.teams = Number(o.teams);
    if (premium) {
      if (!isRoto(sport) && (o.scoring === 'standard' || o.scoring === 'ppr' || o.scoring === 'half')) settings.scoring = o.scoring;
      // Custom NFL roster layout (drives need/forced/scarcity in recommend). Rounds = starters + bench.
      const cs = !isRoto(sport) ? resolveStarters(o.starters) : null;
      if (cs) {
        settings.starters = cs;
        const startCount = Object.values(cs).reduce((a, b) => a + b, 0);
        settings.rounds = Math.max(startCount, Math.min(20, Number(o.rounds) || startCount + 6));
      } else if (Number.isInteger(o.rounds) && o.rounds >= 10 && o.rounds <= 20) {
        settings.rounds = o.rounds;
      }
    }
    const players = await loadPlayers(sport);
    const roster = Array.isArray(b.roster) ? b.roster : [];
    // Advice fires on the user's turn, so the team on the clock at the current overall pick IS the
    // user — derive the pick gap to their NEXT turn (snake mocks) and hand it to recommend(). Made
    // available now for future need-scaling; nothing consumes it yet (needFactor is unchanged).
    const drafted = b.drafted || [];
    const pickIndex = drafted.length;                       // on the clock => picks already made
    const totalPicks = settings.teams * settings.rounds;
    const userTeam = teamOnClock(pickIndex, settings.teams); // snake (mocks are always snake)
    const picksUntilNext = picksUntilNextTurn(pickIndex, userTeam, settings.teams, totalPicks);
    const { candidates, runs, board } = recommend(players, drafted, roster, settings, round, b.recentPicks || [], picksUntilNext);

    // The analyst (Claude) call is the costly part; callers can skip it (e.g. offline
    // mode's real-time refreshes while the user's pick is still a few spots away), in
    // which case we serve the model's own ranked candidates with no rationale.
    let ordered = candidates;
    let rationale = null;
    let reach = false;
    if (b.rationale !== false && candidates.length) {
      const analysis = await analyzePick({
        sport, round, scoring: settings.scoring, teams: settings.teams, roster, candidates, runs, board,
      });
      if (analysis) {
        // Promote Claude's pick to the front so the panel headline + board highlight
        // (which read candidates[0]) reflect the analyst's call.
        const chosen = candidates[analysis.pick - 1];
        ordered = [chosen, ...candidates.filter((_, i) => i !== analysis.pick - 1)];
        rationale = analysis.rationale || null;
        reach = analysis.reach;
      }
    }

    // Hybrid VONA scarcity explanation: when the cliff swung the model's pick AND the final recommended
    // pick is still at that scarcer position, guarantee the concrete startable-count tradeoff shows in
    // the explanation. The deterministic clause carries the numbers; Claude (fed the same facts) adds the
    // reasoning. Gated on the final pick's position so it can't contradict a pick Claude moved elsewhere.
    if (board.vonaSwing && ordered[0]?.pos === board.vonaSwing.pos) {
      const clause = vonaScarcityClause(board.vonaSwing);
      rationale = rationale ? `${clause} ${rationale}` : clause;
    }

    // Slim board summary so the embedded Coach can flag the same roster necessity in chat.
    const boardOut = {
      needs: board.needs, forceNeeds: board.forceNeeds, mustFillNow: board.mustFillNow, fillSoon: board.fillSoon, picksLeft: board.picksLeft,
      weakCats: board.weakCats || null, // NBA-only: roster's lagging categories for the Coach
    };
    return res.json({ candidates: ordered.slice(0, 8), runs, rationale, reach, round, premium, board: boardOut });
  } catch (err) {
    return sendError(res, err);
  }
}
