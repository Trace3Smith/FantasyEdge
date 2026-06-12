// AI fantasy synopsis for prospects (hitters), via the Anthropic API.
//
// Synopses are cached in KV and regenerated ONLY on a threshold event — never on
// a clock — so daily volume stays tiny after the first run. The four events are
// promotion (moved up a level), hot streak, cold streak, and stalled (stopped
// accumulating PAs, a proxy for injury/inactivity). First encounters generate once.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const STALL_DAYS = 7;
const HOT_COLD_PA = 25; // min plate appearances accrued since last synopsis to judge a streak
const HOT_COLD_OPS = 0.15; // window-vs-season OPS gap that counts as hot/cold

const levelOrder = { AAA: 0, AA: 1, 'A+': 2, A: 3, Rk: 4 };
const lvlIdx = (l) => (l in levelOrder ? levelOrder[l] : 99);

// Build the event-detection view of a player's current MiLB line.
export function snapshotOf(milb) {
  const top = milb[0] || { level: '—', pa: 0, ab: 0, h: 0, bb: 0, hbp: 0, sf: 0, tb: 0, ops: '.000' };
  return {
    topLevel: top.level,
    totalPa: milb.reduce((a, l) => a + (l.pa || 0), 0),
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

// Returns one of 'first' | 'promotion' | 'hot' | 'cold' | 'stalled' | null.
// prior is the stored state record; cur is snapshotOf(currentMilb); now is ms.
export function detectEvent(prior, cur, now) {
  if (!prior || !prior.synopsis) return 'first';
  const snap = prior.snapshot;
  if (!snap) return 'first';

  // Promotion: current top level is more advanced than at last synopsis.
  if (lvlIdx(cur.topLevel) < lvlIdx(snap.topLevel)) return 'promotion';

  // Stalled: no PA gain for STALL_DAYS, fired at most once per idle streak.
  const lastGain = prior.lastPaGainAt ? Date.parse(prior.lastPaGainAt) : now;
  const idleMs = now - lastGain;
  if (
    idleMs >= STALL_DAYS * 864e5 &&
    (!prior.stalledFiredAt || Date.parse(prior.stalledFiredAt) < lastGain)
  ) {
    return 'stalled';
  }

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

const SYSTEM = `You write terse fantasy-baseball prospect notes in the style of RotoWire player updates. Write 2-3 sentences, present tense, for a fantasy owner deciding whether to stash the player.
Sentence 1: what the stat line says about his profile (power, hit tool, speed, plate discipline).
Sentence 2: how close he is to the majors given his level (e.g. holding his own at AA, knocking on the door at AAA).
Sentence 3: the fantasy takeaway (stash now, deep-league watch, monitor for call-up, dynasty stash, etc.).
Be plain and confident with no hedging filler. Use ONLY the stat line, level, and grades provided — do not invent comps, velocities, injuries, mechanics, or any scouting detail not given. If the sample is small or the data is thin, say so honestly rather than embellishing. Output only the note, no preamble.`;

function promptFor(p) {
  const lines = p.milb
    .map(
      (l) =>
        `${l.level} (${l.team}): ${l.pa} PA, ${l.avg}/${l.obp}/${l.slg} (${l.ops} OPS), ` +
        `${l.hr} HR, ${l.r} R, ${l.rbi} RBI, ${l.sb} SB`
    )
    .join('\n');
  const meta = [
    `Player: ${p.name}`,
    `Position: ${p.pos}`,
    p.bats ? `Bats: ${p.bats}` : null,
    `Org: ${p.org}`,
    p.fv != null ? `FanGraphs Future Value: ${p.fv}` : null,
    p.eta != null ? `ETA: ${p.eta}` : null,
  ]
    .filter(Boolean)
    .join('\n');
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
        system: SYSTEM,
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
