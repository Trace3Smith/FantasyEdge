// AI fantasy synopsis for prospects (hitters), via the Anthropic API.
//
// Synopses are cached in KV and regenerated ONLY on a threshold event — never on
// a clock — so daily volume stays tiny after the first run. The four events are
// promotion (moved up a level), hot streak, cold streak, and stalled (stopped
// accumulating PAs, a proxy for injury/inactivity). First encounters generate once.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const STALL_DAYS = 7;
const HOT_COLD_PA = 25; // min plate appearances accrued since last synopsis to judge a hitter streak
const HOT_COLD_OPS = 0.15; // window-vs-season OPS gap that counts as hot/cold
const HOT_COLD_OUTS = 45; // min outs (15 IP) accrued since last synopsis to judge a pitcher streak
const HOT_COLD_ERA = 1.5; // window-vs-season ERA gap that counts as hot/cold

const levelOrder = { AAA: 0, AA: 1, 'A+': 2, A: 3, Rk: 4 };
const lvlIdx = (l) => (l in levelOrder ? levelOrder[l] : 99);

// Build the event-detection view of a hitter's current MiLB line. `workload` is
// the monotonic counting stat the stalled-detector tracks (plate appearances).
export function snapshotOf(milb) {
  const top = milb[0] || { level: '—', pa: 0, ab: 0, h: 0, bb: 0, hbp: 0, sf: 0, tb: 0, ops: '.000' };
  const totalPa = milb.reduce((a, l) => a + (l.pa || 0), 0);
  return {
    kind: 'hitter',
    topLevel: top.level,
    workload: totalPa,
    totalPa,
    pa: top.pa,
    ab: top.ab,
    h: top.h,
    bb: top.bb,
    hbp: top.hbp,
    sf: top.sf,
    tb: top.tb,
    ops: parseFloat(top.ops) || 0,
  };
}

// Pitcher counterpart. `workload` here is total outs recorded (IP * 3); the
// hot/cold window is judged on ERA over the new outs at the same level.
export function snapshotOfPitching(milb) {
  const top = milb[0] || { level: '—', outs: 0, er: 0, h: 0, bb: 0, k: 0, era: '0.00' };
  const totalOuts = milb.reduce((a, l) => a + (l.outs || 0), 0);
  return {
    kind: 'pitcher',
    topLevel: top.level,
    workload: totalOuts,
    outs: top.outs,
    er: top.er,
    h: top.h,
    bb: top.bb,
    k: top.k,
    era: parseFloat(top.era) || 0,
  };
}

// Shared promotion + stalled detection (level/workload are kind-agnostic).
// Reads the workload timestamp written by enrichProspects, falling back to the
// pre-Phase-3 field name so existing state records keep working.
function detectLevelOrStall(prior, cur, snap, now) {
  // Promotion: current top level is more advanced than at last synopsis.
  if (lvlIdx(cur.topLevel) < lvlIdx(snap.topLevel)) return 'promotion';

  // Stalled: no workload gain for STALL_DAYS, fired at most once per idle streak.
  const lastAt = prior.lastWorkloadAt || prior.lastPaGainAt;
  const lastGain = lastAt ? Date.parse(lastAt) : now;
  const idleMs = now - lastGain;
  if (
    idleMs >= STALL_DAYS * 864e5 &&
    (!prior.stalledFiredAt || Date.parse(prior.stalledFiredAt) < lastGain)
  ) {
    return 'stalled';
  }
  return null;
}

// Returns one of 'first' | 'promotion' | 'hot' | 'cold' | 'stalled' | null.
// prior is the stored state record; cur is snapshotOf(currentMilb); now is ms.
export function detectEvent(prior, cur, now) {
  if (!prior || !prior.synopsis) return 'first';
  const snap = prior.snapshot;
  if (!snap) return 'first';

  const lvlOrStall = detectLevelOrStall(prior, cur, snap, now);
  if (lvlOrStall) return lvlOrStall;

  // Hot / cold: only at the same level, with enough new PAs to judge a window.
  if (cur.topLevel === snap.topLevel) {
    const dAB = cur.ab - snap.ab;
    const dPA = cur.pa - snap.pa;
    if (dPA >= HOT_COLD_PA && dAB > 0) {
      const onBase = cur.h - snap.h + (cur.bb - snap.bb) + (cur.hbp - snap.hbp);
      const obDen = dAB + (cur.bb - snap.bb) + (cur.hbp - snap.hbp) + (cur.sf - snap.sf);
      const wOBP = obDen > 0 ? onBase / obDen : 0;
      const wSLG = (cur.tb - snap.tb) / dAB;
      const wOPS = wOBP + wSLG;
      if (wOPS - cur.ops >= HOT_COLD_OPS) return 'hot';
      if (cur.ops - wOPS >= HOT_COLD_OPS) return 'cold';
    }
  }
  return null;
}

// Pitcher counterpart of detectEvent. cur is snapshotOfPitching(currentMilb).
// Hot/cold compares ERA over the new outs (same level) against season ERA; a
// LOWER window ERA is hot (pitching well), a higher one is cold.
export function detectEventPitching(prior, cur, now) {
  if (!prior || !prior.synopsis) return 'first';
  const snap = prior.snapshot;
  if (!snap) return 'first';

  const lvlOrStall = detectLevelOrStall(prior, cur, snap, now);
  if (lvlOrStall) return lvlOrStall;

  if (cur.topLevel === snap.topLevel) {
    const dOuts = cur.outs - snap.outs;
    if (dOuts >= HOT_COLD_OUTS) {
      const wERA = ((cur.er - snap.er) * 27) / dOuts; // earned runs per 9 over the window
      if (cur.era - wERA >= HOT_COLD_ERA) return 'hot';
      if (wERA - cur.era >= HOT_COLD_ERA) return 'cold';
    }
  }
  return null;
}

const SYSTEM_HITTER = `You write terse fantasy-baseball prospect notes in the style of RotoWire player updates. Write 2-3 sentences, present tense, for a fantasy owner deciding whether to stash the player.
Sentence 1: what the stat line says about his profile (power, hit tool, speed, plate discipline).
Sentence 2: how close he is to the majors given his level (e.g. holding his own at AA, knocking on the door at AAA).
Sentence 3: the fantasy takeaway (stash now, deep-league watch, monitor for call-up, dynasty stash, etc.).
Be plain and confident with no hedging filler. Use ONLY the stat line, level, and grades provided — do not invent comps, velocities, injuries, mechanics, or any scouting detail not given. If the sample is small or the data is thin, say so honestly rather than embellishing. Output only the note, no preamble.`;

const SYSTEM_PITCHER = `You write terse fantasy-baseball prospect notes in the style of RotoWire player updates. Write 2-3 sentences, present tense, for a fantasy owner deciding whether to stash the pitcher.
Sentence 1: what the stat line says about his profile (strikeout ability from K rate, command from walk rate, run prevention from ERA/WHIP; note whether he's starting or relieving from games-started).
Sentence 2: how close he is to the majors given his level (e.g. holding his own at AA, knocking on the door at AAA).
Sentence 3: the fantasy takeaway (ratios and strikeout upside, saves potential for a reliever, stash now, deep-league watch, monitor for call-up, dynasty stash, etc.).
Be plain and confident with no hedging filler. Use ONLY the stat line, level, and grades provided — do not invent comps, velocities, injuries, mechanics, or any scouting detail not given. If the sample is small or the data is thin, say so honestly rather than embellishing. Output only the note, no preamble.`;

function hittingLines(milb) {
  return milb
    .map(
      (l) =>
        `${l.level} (${l.team}): ${l.pa} PA, ${l.avg}/${l.obp}/${l.slg} (${l.ops} OPS), ` +
        `${l.hr} HR, ${l.r} R, ${l.rbi} RBI, ${l.sb} SB`
    )
    .join('\n');
}

function pitchingLines(milb) {
  return milb
    .map(
      (l) =>
        `${l.level} (${l.team}): ${l.ip} IP, ${l.era} ERA, ${l.whip} WHIP, ` +
        `${l.k} K, ${l.bb} BB, ${l.hr} HR, ${l.w}-${l.l}, ${l.sv} SV, ${l.g} G (${l.gs} GS)`
    )
    .join('\n');
}

function promptFor(p) {
  const pitcher = p.kind === 'pitcher';
  const meta = [
    `Player: ${p.name}`,
    `Position: ${p.pos}`,
    pitcher ? (p.throws ? `Throws: ${p.throws}` : null) : p.bats ? `Bats: ${p.bats}` : null,
    `Org: ${p.org}`,
    p.fv != null ? `FanGraphs Future Value: ${p.fv}` : null,
    p.eta != null ? `ETA: ${p.eta}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const lines = pitcher ? pitchingLines(p.milb) : hittingLines(p.milb);
  return `${meta}\n\n2026 minor-league line(s):\n${lines}`;
}

// Generate a synopsis. Returns the text, or null if no API key / on failure
// (caller keeps any existing cached synopsis on null).
export async function generateSynopsis(p) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !p.milb?.length) return null;
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 220,
        system: p.kind === 'pitcher' ? SYSTEM_PITCHER : SYSTEM_HITTER,
        messages: [{ role: 'user', content: promptFor(p) }],
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const text = j?.content?.[0]?.text?.trim();
    return text || null;
  } catch {
    return null;
  }
}
