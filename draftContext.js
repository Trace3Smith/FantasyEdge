// The Coach chat's live-draft context string, extracted from fantasyedge-draft.html so it has a single
// source of truth and permanent regression coverage (scripts/verify-draft-coach.mjs). Pure and
// dependency-free: every runtime helper and piece of state is injected via `ctx`, so the browser passes
// its own globals/imports and the offline suite passes lightweight stand-ins — both run THIS code.
//
// Trust-critical invariants (see the "you already have <player>" hallucination fix): the ONLY thing
// that states ownership is the YOUR ROSTER line, which lists standard NFL positions even when empty
// ("none"); every available surface (board, shortlist, recent picks) is explicitly labeled NOT owned
// and is not formatted like the roster, so an available player can't be read as rostered.
//
// ctx = {
//   state,                       // the live draft state ({ roster:[{id,pos}], picks, drafted:Set, settings, ... })
//   players, byId, rankMap,      // full pool (array), id->player (Map), id->board-rank (Map)
//   lastBoard, lastReco, lastCandidates,  // latest advise() outputs (board/needs, top pick, ranked shortlist)
//   isRoto, rotoLabel,           // boolean + the roto scoring label (null for NFL)
//   roundOf, boardCmp, adpFor, nflFpts,   // injected helpers (same ones the board uses)
// }
export function buildDraftContext(ctx) {
  const {
    state, players, byId, rankMap, lastBoard, lastReco, lastCandidates,
    isRoto, rotoLabel, roundOf, boardCmp, adpFor, nflFpts,
  } = ctx;
  if (!state) return '';
  const s = state;
  const scoring = isRoto ? rotoLabel : (s.settings.scoring || 'ppr').toUpperCase();
  const scoringCode = isRoto ? null : (s.settings.scoring || 'ppr'); // raw code for adpFor()
  const round = roundOf(s.pickIndex, s.settings.teams);
  const rounds = s.settings.rounds || Math.round(s.totalPicks / s.settings.teams);
  // Explicit per-position OWNERSHIP so an empty slot (e.g. no QB yet) is unmissable and can never be
  // confused with the available board. NFL lists the standard positions even when empty ("none"); roto
  // keeps a flat list. This is the ONLY place that says what the user owns.
  let rosterOwnedStr;
  if (!isRoto) {
    const owned = {};
    for (const r of s.roster) { const p = byId.get(r.id); (owned[r.pos] ||= []).push(p ? p.name : r.pos); }
    const order = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
    rosterOwnedStr = order
      .filter((pos) => ['QB', 'RB', 'WR', 'TE'].includes(pos) || owned[pos]?.length)
      .map((pos) => `${pos}: ${owned[pos]?.length ? owned[pos].join(', ') : 'none'}`).join('; ');
  } else {
    rosterOwnedStr = s.roster.map((r) => { const p = byId.get(r.id); return p ? `${p.pos} ${p.name}` : r.pos; }).join(', ') || 'none yet';
  }
  const recent = s.picks.slice(-8).map((p) => `${p.pos} ${p.name}`).join(', ') || 'none yet';
  // Roto only: best-available overall (NFL uses the per-position board below). Relabeled as NOT-owned.
  const avail = players.filter((p) => !s.drafted.has(p.id))
    .sort(boardCmp)
    .slice(0, 12).map((p) => `${p.name} (${p.pos} #${rankMap.get(p.id) ?? '—'})`).join(', ');

  // Per-position available board (NFL): who's actually left at each position, with ADP, so the Coach
  // can answer "who's on the board at RB?" from real data instead of asking the user to type names.
  // K/DST only appear once they're draft-relevant (final rounds / roster necessity), not from round 1.
  let posBoardStr = '';
  if (!isRoto) {
    const lateForKD = round >= rounds - 2 || lastBoard?.mustFillNow || lastBoard?.fillSoon;
    const positions = ['QB', 'RB', 'WR', 'TE', ...(lateForKD ? ['K', 'DST'] : [])];
    const byPos = {};
    for (const p of players) { if (!s.drafted.has(p.id)) (byPos[p.pos] ||= []).push(p); }
    const lines = [];
    let kdstShown = false;
    for (const pos of positions) {
      const list = (byPos[pos] || []).sort((a, b) => (rankMap.get(a.id) ?? 1e9) - (rankMap.get(b.id) ?? 1e9)).slice(0, 6);
      if (!list.length) continue;
      // K/DST have no meaningful ADP; instead surface the enrichment (p.kdst.label — projection anchor,
      // kicker offense rank + DST defense rank, dome, kicker job security) so the Coach picks the STRONGER
      // K/DST within this window. Annotates only; board order (by rankMap) and the late-window gate above
      // are untouched.
      const kdst = pos === 'K' || pos === 'DST';
      const items = list.map((p) => {
        if (kdst) { if (p.kdst?.label) kdstShown = true; return `${p.name}${p.kdst?.label ? ` (${p.kdst.label})` : ''}`; }
        const a = adpFor(p, scoringCode);
        return `${p.name}${a != null ? ` (ADP ${Math.round(a)})` : ''}`;
      }).join(', ');
      lines.push(`${pos} — ${items}`);
    }
    if (lines.length) {
      posBoardStr = ` ON THE BOARD — available players NOT on your roster (best first by position, with ADP): ${lines.join('; ')}.`;
      if (kdstShown) posBoardStr += ' For K/DST, prefer the stronger option on these signals (projection, offense/defense rank, dome, kicker job security) — this is about WHICH one, not drafting them earlier.';
    }
  }

  // Roster-construction caps the pick engine enforces, surfaced so the Coach's OWN advice respects them
  // (won't hype a 3rd QB or 4th TE) instead of free-forming urgency the recommendation engine wouldn't.
  let guidanceStr = '';
  if (!isRoto) {
    const c = {}; for (const r of s.roster) c[r.pos] = (c[r.pos] || 0) + 1;
    const st = s.settings.starters || {};
    const rules = [];
    if ((st.QB || 1) < 2) rules.push('single-QB league — 1 QB starts, so a 2nd QB is only a bye-week backup and a 3rd+ has ~no value');
    if ((st.TE || 1) < 2) {
      // When a TE is already owned, the ONLY way another TE helps is the single flex — which RB/WR also
      // fill — so a 2nd TE is worth it ONLY if it out-values the best available RB/WR. Stating that gate
      // here stops the Coach recommending a bench TE over a better RB/WR just because "2 TEs is fine".
      rules.push((c.TE || 0) >= 1
        ? 'one TE slot and you already have a TE — another TE only helps via the single flex, which RB/WR also fill, so take a 2nd TE ONLY if its FPTS beats the best available RB/WR; otherwise the RB/WR is the better pick. A 3rd+ TE is never worth it. (The engine already applied this — a capped TE is labeled "extra TE — bench only" in the shortlist.)'
        : 'one TE slot — one starting TE plus at most one flex-worthy TE; a 3rd+ is never worth it over RB/WR');
    }
    rules.push('RB/WR reward real bench depth (flex, byes, injuries), so extra RB/WR keep value');
    guidanceStr = ` Roster construction — current counts QB ${c.QB || 0}, RB ${c.RB || 0}, WR ${c.WR || 0}, TE ${c.TE || 0}.`
      + ` Caps the engine follows: ${rules.join('; ')}. Don't push a "must-grab" at a position already stacked unless the value is genuinely elite.`;
  }

  // The engine's need/desire-weighted ranked shortlist (QB/TE caps + ADP-value baked in), each carrying
  // its Rankings-page depth signals (projection, weekly floor/ceiling, opportunity) so the Coach can
  // reason on real depth for head-to-head comparisons — not just ADP/raw projection. Signals are looked
  // up from the full player row and only shown when present (consistency/ceiling ~ top-150 skill only).
  const sigStr = (p) => {
    if (!p) return '';
    const bits = [];
    if (p.fpPpr != null) bits.push(`${Math.round(nflFpts(p, scoringCode))} FPTS`);  // the blend — the board's ranking value
    if (p.proj?.fpts != null) bits.push(`proj ${Math.round(p.proj.fpts)}`);          // raw projection (one input to the blend)
    if (p.consistency != null) bits.push(`consistency ${p.consistency}/100`);
    if (p.ceiling != null) bits.push(`~${Math.round(p.ceiling)}pt ceiling`);
    if (p.opportunity?.label) bits.push(p.opportunity.label);
    return bits.length ? ` (${bits.join(', ')})` : '';
  };
  const shortlistStr = (lastCandidates && lastCandidates.length)
    ? ` Engine's need-aware ranked shortlist this pick — AVAILABLE players to consider (none are on the user's roster); already in board order; rank and compare by FPTS (our blended ranking value = projection + recent actuals), NOT by the separate "proj" figure: ${lastCandidates.map((c) => `${c.pos} ${c.name}${c.reasonLabel ? ` [${c.reasonLabel}]` : ''}${sigStr(byId.get(c.id))}`).join('; ')}.`
    : '';
  // Roto: surface the roster's weak categories so the Coach steers toward balance.
  const weakStr = isRoto && lastBoard?.weakCats?.length
    ? ` Weak categories right now: ${lastBoard.weakCats.join(', ')}.` : '';
  // Fold in the pick you just recommended so follow-ups ("why not the WR?") stay coherent.
  const recoStr = lastReco
    ? ` Your current recommendation to the user this pick: ${lastReco.name} (${lastReco.pos}, ${lastReco.team})${lastReco.rationale ? ' — ' + lastReco.rationale : ''}.`
    : '';
  // Late-draft roster necessity: nudge the Coach to recommend filling mandatory K/DST (or
  // any open required slot) once the user is out of (or nearly out of) spare picks.
  let needStr = '';
  const needPos = (lastBoard?.needs || []).map((n) => n.pos);
  if (lastBoard?.mustFillNow && needPos.length) {
    needStr = ` ROSTER NECESSITY: the user still must fill ${needPos.join(' and ')} and has only ${lastBoard.picksLeft} pick(s) left — they can't field a legal lineup without them, so recommend drafting ${needPos.join('/')} now even though the value is low.`;
  } else if (lastBoard?.fillSoon && needPos.length) {
    needStr = ` Roster heads-up: mandatory ${needPos.join('/')} still open with only ${lastBoard.picksLeft} picks left — one more value pick is fine, but plan to grab ${needPos.join('/')} within the next pick or two.`;
  }
  const availStr = isRoto ? ` ON THE BOARD — best available players NOT on your roster: ${avail}.` : '';
  return `Mode: ${s.mode === 'mock' ? 'mock draft vs AI opponents' : 'tracking a real league draft'}. `
    + `League: ${s.settings.teams}-team ${scoring}, ${rounds} rounds, ${s.format}. `
    + `User's draft slot: ${s.userTeam + 1}. Now: round ${round}, overall pick ${s.pickIndex + 1}. `
    + `YOUR ROSTER (the players the user OWNS — only these are on their team; a position marked "none" is UNFILLED): ${rosterOwnedStr}. `
    + `Recent picks across all teams (NOT the user's roster): ${recent}.`
    + `${availStr}${posBoardStr}${guidanceStr}${shortlistStr}${weakStr}${recoStr}${needStr}`;
}
