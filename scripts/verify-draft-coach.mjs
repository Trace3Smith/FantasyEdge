// Offline regression check for two Draft Coach tuning refinements in api/_lib/draft.js.
// Exercises the REAL recommend() / vonaScarcityClause() (nothing reimplemented) against
// synthetic pools, and exits non-zero on any failure so it can gate CI or a pre-push hook.
//
//   node scripts/verify-draft-coach.mjs
//
// Covers:
//   PART 1 — VONA scarcity swing surfaces a numbers-only clause (no reasoning tail).
//   PART 2 — TE flex-cap: a 2nd TE is a low-baseline bench pick that spikes when it beats
//            the flex-eligible RB/WR, stays present (not blocked) when they're richer, and
//            surfaces once they thin — a priority nudge, not a hard gate.
//   PART 3 — VONA draft-progress gate: no scarcity framing in round 1 (nothing drafted yet);
//            the same board fires once a full round has actually thinned it.
//   PART 4 — TE anti-hoard: a 3-TE roster never takes a 4th TE, even at an extreme raw value.
//   PART 5 — Coach context: roster ownership is unambiguous (empty slots read "none").
//   PART 6 — Flex-worthy TE2 label + guidance: a non-flex-worthy 2nd TE reads as a capped bench pick
//            (not endorsed "TE depth"), and the guidance carries the flex-comparison rule.
//   PART 7 — Flex comparison uses OUTPUT, not positional VORP: a 2nd TE with higher positional VORP but
//            lower raw output than the best WR is still capped (and not the "My pick").
//   PART 8 — Filled/open starting-slot summary (board.slots): a filled slot is marked FILLED (not a
//            need) and an empty slot OPEN, so the "My pick" analyst can't invent a need at a filled slot.
//   PART 9 — Endgame ADP-boost decay (the Hollywood Brown / last-pick bug): a falling-ADP name that
//            legitimately leads mid-draft (future picks to protect) must NOT out-rank a higher-value
//            player on the FINAL pick, where ADP "pounce before others take him" value is moot.
//   PART 10 — Candidate-pool consistency with the Coach chat: the per-position VALUE leader the chat
//            can tout is always in the "My pick" shortlist, even when top-12-by-score would drop it.
//   PART 11 — Reach-headline honesty (the Josh Allen bug): the "My pick" reach suffix is worded from the
//            pick's ACTUAL adpDelta — a player taken AHEAD of his ADP is never called "falling past ADP".
//   PART 12 — Reach-flag overload: the coarse board-row reason is derived from adpDelta too, so an off-need
//            reach that isn't a genuine faller reads as 'reach', not blanket 'value'.
//   PART 13 — Scarcity line excludes K/DST: streamed last-round positions never sort to the front of the
//            analyst's "fewest first" scarcity list, so it can't frame them as urgent alongside QB/TE.
//   PART 14 — ADP-fit magnitude honesty (the "slight reach" bug): the analyst's ADP-fit line sizes a reach
//            by its actual gap — a full round or more reads "a notable reach", never a hardcoded "slight".
//   PART 17 — K/DST v1 enrichment (which K/DST, not when): kdstForPlayer() fuses projection + offense tier +
//            dome + kicker job-security into one label, and the Coach context surfaces it for K/DST rows in
//            the late-round window only — timing (SCARCITY_SKIP_POS / VORP) untouched.

import { recommend, vonaScarcityClause, scarcityLine, DEFAULT_SETTINGS, adpFor } from '../api/_lib/draft.js';
import { reachSuffix, pickReasonTag, adpFitPhrase } from '../pickReasons.js';
import { buildDraftContext } from '../draftContext.js';
import { nflFpts } from '../nflScoring.js';
import { kdstForPlayer } from '../api/_lib/enrichNflKdst.js';
import { keyFor } from '../api/_lib/fantasyProjections.js';

const settings = { ...DEFAULT_SETTINGS, sport:'nfl', teams:12, rounds:15 };
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`   ${ok?'✅':'❌'} ${name}${detail?` — ${detail}`:''}`); };

// ============================================================================
// PART 1 — VONA swing -> numbers-only clause (shipped behavior).
// Faithfully replays recommend() -> board.vonaSwing, then advise.js's rationale:false
// clause-prepend using the real vonaScarcityClause().
// ============================================================================
console.log('PART 1 — VONA scarcity swing -> clause');
{
  const P = []; const mk = (pos,i,fp) => P.push({ id:`${pos}${i}`, name:`${pos}-${i}`, team:'X', pos, rank:P.length+1, fpPpr:fp });
  for (let i=1;i<=24;i++) mk('QB', i, 360 - i*7);
  for (let i=1;i<=60;i++) mk('RB', i, 330 - i*5);
  for (let i=1;i<=60;i++) mk('WR', i, 310 - i*5);
  for (let i=1;i<=24;i++) mk('TE', i, i<=5 ? 210 - (i-1)*18 : 110 - (i-5)*6); // steep elite top-5, shallow tail
  for (let i=1;i<=16;i++) mk('K',   i, 150 - i*4);
  for (let i=1;i<=16;i++) mk('DST', i, 150 - i*4);

  const CUT = { TE:5, RB:15, WR:15, QB:10 };
  const topIds = (pos,n) => P.filter(p=>p.pos===pos).sort((a,b)=>b.fpPpr-a.fpPpr).slice(0,n).map(p=>p.id);
  const drafted = [...topIds('TE',CUT.TE),...topIds('RB',CUT.RB),...topIds('WR',CUT.WR),...topIds('QB',CUT.QB)];

  const roster = [ {id:'q',pos:'QB'},{id:'r1',pos:'RB'},{id:'r2',pos:'RB'},{id:'w1',pos:'WR'},{id:'w2',pos:'WR'},{id:'r3',pos:'RB'} ]; // no TE => TE is a need
  const { candidates, board } = recommend(P, drafted, roster, settings, 7, ['TE','TE','TE','RB']);

  let ordered = candidates, rationale = null; // rationale:false path (no Claude)
  if (board.vonaSwing && ordered[0]?.pos === board.vonaSwing.pos) rationale = vonaScarcityClause(board.vonaSwing);

  console.log('   swing:', JSON.stringify(board.vonaSwing), '| pick:', ordered[0]?.pos, '| rationale:', JSON.stringify(rationale));
  const numbersOnly = /^Only \d+ startable \w+ left vs\. \d+ \w+\.$/.test(rationale || '');
  const noTail = !/drying up faster|worth prioritizing/i.test(rationale || '');
  check('swing fires, pick is the scarce TE need', board.vonaSwing?.pos === 'TE' && ordered[0]?.pos === 'TE');
  check('clause is numbers-only, no reasoning tail', !!rationale && numbersOnly && noTail);
}

// ============================================================================
// PART 2 — TE flex-cap.
// Roster already has its 1 TE starter, so a 2nd TE is surplus-0 and flex-gated.
// Flat replacement (floor=10) lets bestVorp per position be set directly, isolating
// the flex comparison. Verifies: (A) spikes to #1 when it beats the flex, (B) stays
// low-priority-but-PRESENT when RB/WR are rich (not blocked), (C) surfaces to #1 once
// RB/WR value has thinned below it.
// ============================================================================
console.log('\nPART 2 — TE flex-cap (low baseline + flex spike)');
function flexPool({ teTop, rbTop, wrTop }) {
  const ps = []; let id = 0;
  const mk = (pos,fp) => ps.push({ id:`f${++id}`, name:`${pos}-${fp}`, team:'X', pos, rank:id, fpPpr:fp });
  for (let i=0;i<20;i++) mk('QB', 40 - i);                                    // low QBs (roster has its QB)
  mk('RB', rbTop); for (let i=1;i<40;i++) mk('RB', i<3 ? rbTop-8*i : 10);     // top RB then floor=10
  mk('WR', wrTop); for (let i=1;i<40;i++) mk('WR', i<3 ? wrTop-8*i : 10);
  mk('TE', teTop); for (let i=1;i<20;i++) mk('TE', 10);                       // one live TE, rest at floor
  for (let i=0;i<15;i++) mk('K', 10); for (let i=0;i<15;i++) mk('DST', 10);
  return ps;
}
// Roster HAS its TE starter -> next TE is surplus-0 (flex-gated).
const flexRoster = [ {id:'q',pos:'QB'},{id:'r1',pos:'RB'},{id:'r2',pos:'RB'},{id:'w1',pos:'WR'},{id:'w2',pos:'WR'},{id:'t1',pos:'TE'} ];
const teInfo = (cfg) => {
  const { candidates } = recommend(flexPool(cfg), new Set(), flexRoster, settings, 5, []);
  const idx = candidates.findIndex(c => c.pos === 'TE');
  return { top: candidates[0]?.pos, idx, te: candidates[idx], board: candidates.slice(0,4).map(c=>`${c.pos} v${c.vorp}`).join(' | ') };
};

const A = teInfo({ teTop:200, rbTop:160, wrTop:150 }); // TE bestVorp 190 > flex 150 -> spike
const B = teInfo({ teTop:80,  rbTop:240, wrTop:230 }); // TE bestVorp 70  < flex 230 -> low but present
const C = teInfo({ teTop:80,  rbTop:60,  wrTop:55  }); // RB/WR thinned below TE -> TE wins flex, surfaces
console.log('   A spike   :', A.board, '=> pick', A.top);
console.log('   B rich    :', B.board, '=> pick', B.top, `(2nd TE at shortlist #${B.idx+1})`);
console.log('   C thinned :', C.board, '=> pick', C.top, `(2nd TE at shortlist #${C.idx+1})`);

check('A: 2nd TE SPIKES to #1 when it beats the flex', A.top === 'TE');
check('B: 2nd TE is low-priority but PRESENT (not blocked)', B.top !== 'TE' && B.idx >= 0);
check('C: 2nd TE SURFACES to #1 once RB/WR thin below it', C.top === 'TE');
check('B ranks the 2nd TE below where C does (priority shifts with the flex)', B.idx > C.idx);

// ============================================================================
// PART 3 — VONA draft-progress gate (round 1 must not fire).
// Synthetic pool where WR is naturally scarcer than RB by pool SHAPE (fewer startable) with a
// higher-VORP RB sitting deeper, so at pick 1 the WR need is scored[0] over that RB. Re-running the
// SAME board with a full round of picks made (taken.size padded past `teams`) shows it's the gate —
// not the absence of a pattern — that silences round 1, and that real thinning re-enables VONA.
// ============================================================================
console.log('\nPART 3 — VONA draft-progress gate (no scarcity talk in round 1)');
{
  const ps = []; let id = 0;
  const mk = (pos,fp) => ps.push({ id:`g${++id}`, name:`${pos}-${fp}`, team:'X', pos, rank:id, fpPpr:fp });
  [58,54,50,47,44].forEach(v=>mk('WR',v)); for (let i=0;i<35;i++) mk('WR',10);                        // 5 startable WR (scarce)
  [60,57,54,51,48,45,42,39,36,33,30,28].forEach(v=>mk('RB',v)); for (let i=0;i<28;i++) mk('RB',10);   // 12 startable RB (deep), higher top VORP
  for (let i=0;i<12;i++) mk('QB',40-i); for (let i=0;i<8;i++) mk('QB',10);
  for (let i=0;i<10;i++) mk('TE',35-i*2); for (let i=0;i<10;i++) mk('TE',10);
  for (let i=0;i<15;i++) mk('K',10); for (let i=0;i<15;i++) mk('DST',10);

  const r1     = recommend(ps, [], [], settings, 1, []);                                              // taken.size 0
  const padded = recommend(ps, Array.from({length:settings.teams+4},(_,i)=>`x${i}`), [], settings, 3, []); // SAME board, taken.size > teams
  const sw = padded.board.vonaSwing;
  console.log('   round 1 (taken 0) vonaSwing:', JSON.stringify(r1.board.vonaSwing),
              `| after a full round (taken ${settings.teams+4}):`, JSON.stringify(sw));
  check('round 1 (nothing drafted) does NOT fire VONA', r1.board.vonaSwing === null);
  check('same board DOES fire once a full round is drafted (gate, not missing pattern)', !!sw && r1.candidates[0]?.pos === sw.pos);
  check('the fired swing clears the >=2 min startable gap', !!sw && (sw.altStartable - sw.startable) >= 2);
}

// ============================================================================
// PART 4 — TE anti-hoard (regression for the 5-TE bug).
// With 3 TEs already rostered and RB/WR drafted to replacement (bestVorp ~0), winsFlex is trivially
// true — the exact hoard trigger. A 4th TE must NEVER be recommended over a usable RB/WR/flex body,
// even at an extreme raw value: the flex spike is gated to the 2nd TE, and a 4th+ TE's VORP is zeroed
// (like K/DST) since it can't reach a startable slot.
// ============================================================================
console.log('\nPART 4 — TE anti-hoard (3-TE roster must never take a 4th)');
{
  const flooredPool = (teTop) => {
    const ps = []; let id = 0;
    const mk = (pos,fp) => ps.push({ id:`h${++id}`, name:`${pos}-${fp}`, team:'X', pos, rank:id, fpPpr:fp });
    for (let i=0;i<40;i++) mk('RB',10); for (let i=0;i<40;i++) mk('WR',10); for (let i=0;i<20;i++) mk('QB',10); // all at replacement -> bestVorp ~0
    mk('TE',teTop); for (let i=0;i<19;i++) mk('TE',10);                                                        // one live TE + floor
    for (let i=0;i<15;i++) mk('K',10); for (let i=0;i<15;i++) mk('DST',10);
    return ps;
  };
  const roster3TE = [{pos:'QB'},{pos:'RB'},{pos:'RB'},{pos:'WR'},{pos:'WR'},{pos:'TE'},{pos:'TE'},{pos:'TE'}];
  const pickPos = (teTop) => recommend(flooredPool(teTop), new Set(), roster3TE, settings, 9, []).candidates[0]?.pos;
  const midPick = pickPos(35);   // best available TE ~ +25 VORP (mid-tier, like the reported Ferguson/Pitts)
  const extPick = pickPos(70);   // best available TE ~ +60 VORP (absurd faller) — must STILL not be a 4th TE
  console.log('   3-TE roster, mid-tier TE available (+25 VORP) -> pick', midPick);
  console.log('   3-TE roster, extreme TE available  (+60 VORP) -> pick', extPick);
  check('a 4th TE is NOT taken over usable RB/WR/flex (mid-tier)', midPick !== 'TE');
  check('a 4th TE is NEVER taken regardless of raw value (extreme faller)', extPick !== 'TE');
}

// ============================================================================
// PART 5 — Coach draft-context roster ownership (regression for the "you already have <player>"
// hallucination). Exercises the extracted, shared builder (draftContext.js — the SAME code the browser
// runs) for the exact incident: an empty-QB roster while QBs sit on the board. The ONLY ownership
// statement is the YOUR ROSTER line; empty positions read "none"; available surfaces are labeled NOT
// owned and not formatted like the roster — so an available QB can't be misread as rostered.
// ============================================================================
console.log('\nPART 5 — Coach context: roster ownership is unambiguous (empty-QB roster)');
{
  // Pool: a couple of available QBs + skill players. Roster holds RB/RB/WR/WR/TE, NO QB.
  const mk = (id, pos, name, fpPpr, adp) => ({ id, pos, name, fpPpr, proj:{fpts:fpPpr}, adp: adp!=null?{ppr:adp}:undefined });
  const pool = [
    mk('qb1','QB','Lamar Jackson',300,19), mk('qb2','QB','Joe Burrow',290,24), mk('qb3','QB','Dak Prescott',270,33),
    mk('rb1','RB','Bijan Robinson',340,2), mk('rb2','RB','Saquon Barkley',330,3),
    mk('wr1','WR','Puka Nacua',334,3), mk('wr2','WR','CeeDee Lamb',320,5),
    mk('te1','TE','Trey McBride',263,35),
  ];
  const byId = new Map(pool.map(p => [p.id, p]));
  const rankMap = new Map(pool.map((p, i) => [p.id, i + 1]));
  const drafted = new Set(['rb1','rb2','wr1','wr2','te1']); // the user's own picks are "drafted"
  const state = {
    mode:'mock', format:'standard', userTeam:4, pickIndex:60, totalPicks:180,
    settings:{ teams:12, rounds:15, scoring:'ppr', starters:{QB:1,RB:2,WR:2,TE:1,FLEX:1,K:1,DST:1} },
    drafted,
    roster:[{id:'rb1',pos:'RB'},{id:'rb2',pos:'RB'},{id:'wr1',pos:'WR'},{id:'wr2',pos:'WR'},{id:'te1',pos:'TE'}], // NO QB
    picks:[{pos:'QB',name:'Josh Allen'}], // another team took a QB — must NOT read as the user's
  };
  const ctx = buildDraftContext({
    state, players: pool, byId, rankMap, lastBoard: null, lastReco: null,
    lastCandidates: [{ id:'qb1', pos:'QB', name:'Lamar Jackson', reasonLabel:'fills QB need' }],
    isRoto: false, rotoLabel: null,
    roundOf: (i, teams) => Math.floor(i / teams) + 1,
    boardCmp: (a, b) => (rankMap.get(a.id) ?? 1e9) - (rankMap.get(b.id) ?? 1e9),
    adpFor, nflFpts,
  });
  const rosterSeg = ctx.slice(ctx.indexOf('YOUR ROSTER'), ctx.indexOf('Recent picks'));
  console.log('   YOUR ROSTER segment:', rosterSeg.trim());
  check('roster line marks the empty QB slot as "QB: none"', /QB: none/.test(rosterSeg));
  check('no owned QB name invented in the roster line', !/Lamar|Burrow|Dak|Josh Allen/.test(rosterSeg));
  check('available QBs are present but labeled NOT on your roster', /NOT on your roster/.test(ctx) && ctx.includes('Lamar Jackson'));
  check('another team\'s QB pick is labeled NOT the user\'s', /Recent picks across all teams \(NOT the user's roster\)/.test(ctx));
  check('shortlist QB is labeled AVAILABLE (none on the roster)', /AVAILABLE players to consider \(none are on the user's roster\)/.test(ctx));
}

// ============================================================================
// PART 6 — Flex-worthy TE2: label + guidance (regression for the "Coach took a bench TE over a better
// RB" incident). Roster owns one TE; the best available TE does NOT out-value the best RB/WR flex option,
// so it must read as a CAPPED bench pick (not endorsed "TE depth"), and the guidance must carry the
// flex-comparison rule. Then flip it: a genuinely flex-worthy best TE must NOT be capped.
// ============================================================================
console.log('\nPART 6 — flex-worthy TE2 label + guidance');
{
  // Flat replacement floor so per-position bestVorp is directly controllable (like PART 4).
  const pool = (teTop, rbTop) => {
    const ps = []; let id = 0;
    const mk = (pos,fp,name) => ps.push({ id:`v${++id}`, pos, name: name||`${pos}-${fp}`, fpPpr:fp, proj:{fpts:fp}, adp:{ppr:50} });
    mk('RB', rbTop, 'Best RB'); for (let i=1;i<40;i++) mk('RB', i<3 ? rbTop-8*i : 10);
    for (let i=0;i<40;i++) mk('WR', 10); for (let i=0;i<20;i++) mk('QB', 10);
    mk('TE', teTop, 'Best TE'); for (let i=1;i<20;i++) mk('TE', 10);
    for (let i=0;i<15;i++) mk('K', 10); for (let i=0;i<15;i++) mk('DST', 10);
    return ps;
  };
  const roster1TE = [{pos:'QB'},{pos:'RB'},{pos:'RB'},{pos:'WR'},{pos:'WR'},{pos:'TE'}]; // owns one TE
  const teLabel = (teTop, rbTop) => {
    const { candidates } = recommend(pool(teTop, rbTop), new Set(), roster1TE, settings, 8, []);
    return candidates.find(c => c.pos === 'TE')?.reasonLabel || '';
  };
  // teTop 150 (VORP ~140) < best RB VORP ~230 -> NOT flex-worthy -> capped bench label.
  const cappedLabel = teLabel(150, 240);
  // teTop 260 (VORP ~250) > best RB VORP ~150 -> flex-worthy -> plain "TE depth".
  const worthyLabel = teLabel(260, 160);
  console.log('   non-flex-worthy best TE label:', JSON.stringify(cappedLabel));
  console.log('   flex-worthy best TE label    :', JSON.stringify(worthyLabel));
  check('a non-flex-worthy 2nd TE reads as a capped bench pick (not "TE depth")', /bench only/.test(cappedLabel) && !/^TE depth/.test(cappedLabel));
  check('a flex-worthy best TE is NOT capped (plain TE depth)', /TE depth/.test(worthyLabel) && !/bench only/.test(worthyLabel));

  // Guidance carries the flex-comparison rule when the user already owns a TE.
  const players = pool(150, 240);
  const byId = new Map(players.map(p => [p.id, p]));
  const rankMap = new Map(players.map((p, i) => [p.id, i + 1]));
  const roster = [{id:'x',pos:'QB'},{id:'y',pos:'RB'},{id:'z',pos:'RB'},{id:'w',pos:'WR'},{id:'v',pos:'WR'},{id:byId.keys().next().value && [...byId.values()].find(p=>p.pos==='TE')?.id, pos:'TE'}];
  const ctx = buildDraftContext({
    state:{ mode:'mock', format:'std', userTeam:0, pickIndex:80, totalPicks:180,
      settings:{ teams:12, rounds:15, scoring:'ppr', starters:{QB:1,RB:2,WR:2,TE:1,FLEX:1,K:1,DST:1} },
      drafted:new Set(), roster, picks:[] },
    players, byId, rankMap, lastBoard:null, lastReco:null, lastCandidates:[],
    isRoto:false, rotoLabel:null, roundOf:(i,t)=>Math.floor(i/t)+1,
    boardCmp:(a,b)=>(rankMap.get(a.id)??1e9)-(rankMap.get(b.id)??1e9), adpFor, nflFpts,
  });
  check('guidance states the 2nd-TE flex-comparison rule when a TE is owned', /take a 2nd TE ONLY if its FPTS beats the best available RB\/WR/.test(ctx));
}

// ============================================================================
// PART 7 — Flex comparison is by OUTPUT, not positional VORP (regression for the "My pick took a 2nd TE
// over a better WR" bug). A DEEP WR pool (high WR replacement) + a SHALLOW TE pool (low TE replacement)
// makes the best TE out-VORP the best WR while UNDER-producing it on raw output. The flex should go by
// output, so the TE must be capped and must NOT be the pick — even though positional VORP favors it.
// ============================================================================
console.log('\nPART 7 — flex comparison uses output, not positional VORP');
{
  const ps = []; let id = 0;
  const mk = (pos,fp) => ps.push({ id:`o${++id}`, pos, name:`${pos}-${Math.round(fp)}`, fpPpr:fp, proj:{fpts:fp} });
  // WR: a top WR at 198 over a HIGH replacement floor (~185 across the pool) -> best-WR VORP small (~13),
  // and few WRs clear the floor, so a capped TE stays visible in the shortlist rather than buried.
  mk('WR', 198); mk('WR', 190); for (let i=0;i<40;i++) mk('WR', 185);
  // TE: shallow — top 196 declining steeply so the ~13th (replacement) is ~148 -> best-TE VORP large (~48).
  for (let i=0;i<13;i++) mk('TE', 196 - i*4); for (let i=0;i<10;i++) mk('TE', 100);
  for (let i=0;i<25;i++) mk('RB', 150);                // flat, modest RB (VORP ~0) so WR is the best flex
  for (let i=0;i<20;i++) mk('QB', 10);
  for (let i=0;i<15;i++) mk('K', 10); for (let i=0;i<15;i++) mk('DST', 10);
  const roster = [{pos:'QB'},{pos:'RB'},{pos:'RB'},{pos:'WR'},{pos:'WR'},{pos:'TE'}]; // owns one TE
  const { candidates } = recommend(ps, new Set(), roster, settings, 8, []);
  const bestTE = candidates.find(c => c.pos === 'TE');
  const bestWR = candidates.find(c => c.pos === 'WR');
  console.log(`   best TE: raw ${bestTE?.value} VORP ${bestTE?.vorp} [${bestTE?.reasonLabel}]`);
  console.log(`   best WR: raw ${bestWR?.value} VORP ${bestWR?.vorp}`);
  console.log('   My pick:', candidates[0]?.pos, candidates[0]?.name);
  // Precondition: this is genuinely the VORP-vs-output divergence (TE out-VORPs the WR, under-produces it).
  check('scenario is the divergence (best TE has higher VORP but lower raw output than best WR)',
        bestTE && bestWR && bestTE.vorp > bestWR.vorp && bestTE.value < bestWR.value);
  check('the higher-VORP-but-lower-output TE is capped (flex judged by output)', /bench only/.test(bestTE?.reasonLabel || ''));
  check('"My pick" is not that 2nd TE', candidates[0]?.pos !== 'TE');
}

// ============================================================================
// PART 8 — Filled/open starting-slot summary (regression for the inverse hallucination: "you still have
// a QB spot to fill" when QB is rostered). recommend() must expose board.slots marking a filled slot as
// FILLED (not a need) and an empty slot OPEN — the explicit breakdown the "My pick" analyst reads so it
// can't invent a need at a filled slot (nor miss an open one).
// ============================================================================
console.log('\nPART 8 — filled/open starting-slot summary (board.slots)');
{
  const pool = []; let id = 0;
  const mk = (pos,fp) => pool.push({ id:`s${++id}`, pos, name:`${pos}-${fp}`, fpPpr:fp, proj:{fpts:fp} });
  for (let i=0;i<20;i++) mk('QB', 200-i); for (let i=0;i<40;i++) mk('RB', 200-i);
  for (let i=0;i<40;i++) mk('WR', 200-i); for (let i=0;i<20;i++) mk('TE', 160-i);
  for (let i=0;i<15;i++) mk('K', 100); for (let i=0;i<15;i++) mk('DST', 100);
  const st = { teams:12, rounds:15, scoring:'ppr', starters:{QB:1,RB:2,WR:2,TE:1,FLEX:1,K:1,DST:1} };
  // Roster: QB + RB/RB + WR/WR filled; TE/K/DST still open. (The reported scenario — QB is FILLED.)
  const roster = [{id:'a',pos:'QB'},{id:'b',pos:'RB'},{id:'c',pos:'RB'},{id:'d',pos:'WR'},{id:'e',pos:'WR'}];
  const { board } = recommend(pool, new Set(), roster, { ...settings, ...st }, 6, []);
  console.log('   board.slots:', JSON.stringify(board.slots));
  check('board.slots exists with filled + open arrays', !!board.slots && Array.isArray(board.slots.filled) && Array.isArray(board.slots.open));
  check('a FILLED QB is marked filled, not open', board.slots?.filled.includes('QB') && !board.slots?.open.includes('QB'));
  check('an unfilled TE is marked open', board.slots?.open.includes('TE'));
  check('filled RB/WR pairs are counted (2 each), not shown as open', board.slots?.filled.filter(p=>p==='RB').length === 2 && !board.slots?.open.includes('RB') && !board.slots?.open.includes('WR'));
}

// ============================================================================
// PART 9 — Endgame ADP-boost decay (regression for the Hollywood Brown / last-pick bug: a lower-value
// name that only leads because it fell past its ADP was still winning the FINAL pick, where ADP is moot).
// Two RB candidates (identical needFactor, so only (vorp+0.5)*adpBoost separates them): RB-VALUE has the
// higher raw value with ADP right at the pick, RB-FALLER has lower value but fell far past ADP. Same pool
// and roster, only the draft horizon changes (via rounds -> picksLeft). Mid-draft (picksLeft>1) the faller
// legitimately leads (future picks to protect). On the final pick (picksLeft<=1) the boost must decay to
// ~0 so the best player available (RB-VALUE) leads instead.
// ============================================================================
console.log('\nPART 9 — endgame ADP-boost decay (last-pick takes best value, not the ADP faller)');
{
  const pool = () => {
    const ps = []; let id = 0;
    const mk = (pos,fp,adp,name) => ps.push({ id:`e${++id}`, pos, name: name||`${pos}-${fp}`, team:'X', rank:id, fpPpr:fp, proj:{fpts:fp}, adp: adp!=null?{ppr:adp,standard:adp}:undefined });
    mk('RB', 140, 99, 'RB-VALUE');        // higher value, ADP ~ current pick (no boost)
    mk('RB', 125,  1, 'RB-FALLER');       // lower value, fell way past ADP (boosted mid-draft)
    for (let i=0;i<40;i++) mk('RB', 60); for (let i=0;i<40;i++) mk('WR', 55);   // deep floors: both leaders clear replacement
    for (let i=0;i<20;i++) mk('QB', 40); for (let i=0;i<20;i++) mk('TE', 35);
    for (let i=0;i<15;i++) mk('K', 10); for (let i=0;i<15;i++) mk('DST', 10);
    return ps;
  };
  // All mandatory slots filled (QB,RB,RB,WR,WR,TE,K,DST) -> gap 0 everywhere, nothing forced in either run.
  const roster = [{id:'q',pos:'QB'},{id:'r1',pos:'RB'},{id:'r2',pos:'RB'},{id:'w1',pos:'WR'},{id:'w2',pos:'WR'},{id:'t',pos:'TE'},{id:'k',pos:'K'},{id:'d',pos:'DST'}];
  const drafted = new Set(Array.from({length:99},(_,i)=>`taken${i}`)); // currentPick ~100 -> RB-FALLER (adp 1) is a big faller
  const run = (rounds) => {
    const { candidates } = recommend(pool(), drafted, roster, { ...settings, rounds }, 8, []);
    return { top: candidates[0], val: candidates.find(c=>c.name==='RB-VALUE'), fal: candidates.find(c=>c.name==='RB-FALLER'), picksLeft: rounds - roster.length };
  };
  const mid = run(15);   // picksLeft 7 -> full ADP horizon
  const fin = run(9);    // picksLeft 1 -> final pick, ADP horizon ~0
  console.log(`   mid-draft (picksLeft ${mid.picksLeft}): pick ${mid.top?.name} [VALUE ${mid.val?.score} vs FALLER ${mid.fal?.score}]`);
  console.log(`   final pick (picksLeft ${fin.picksLeft}): pick ${fin.top?.name} [VALUE ${fin.val?.score} vs FALLER ${fin.fal?.score}]`);
  check('mid-draft: the falling-ADP name legitimately leads (boost intact)', mid.top?.name === 'RB-FALLER');
  check('final pick: the higher-value name leads (ADP boost decayed to ~0)', fin.top?.name === 'RB-VALUE');
  check('final pick: the ADP faller no longer out-scores the value player', fin.val?.score > fin.fal?.score);
}

// ============================================================================
// PART 10 — Candidate-pool consistency with the Coach chat (root-cause half of the Hollywood Brown issue:
// advise.js's shortlist and the chat's per-position board drew from different pools, so a high-VALUE name
// the chat would tout could be absent from the "My pick" shortlist). recommend() must union the per-
// position VALUE leader into the returned shortlist even when top-12-by-score would drop it. Here a
// WR-heavy roster (low WR desire) buries the highest-value WR below a wall of need/ADP-boosted RBs; the
// union must still surface it.
// ============================================================================
console.log('\nPART 10 — candidate-pool consistency (per-position value leader always in the shortlist)');
{
  const ps = []; let id = 0;
  const mk = (pos,fp,adp,name) => ps.push({ id:`c${++id}`, pos, name: name||`${pos}-${fp}`, team:'X', rank:id, fpPpr:fp, proj:{fpts:fp}, adp: adp!=null?{ppr:adp,standard:adp}:undefined });
  mk('WR', 240, 90, 'WR-VALUE-LEADER');                                   // highest raw WR value, no ADP boost, low desire
  for (let i=0;i<14;i++) mk('RB', 150 - i, 1, `RB-faller-${i}`);          // 14 need+ADP-boosted RBs fill the top-12 by score
  for (let i=0;i<30;i++) mk('WR', 60); for (let i=0;i<30;i++) mk('RB', 55);
  for (let i=0;i<20;i++) mk('QB', 40); for (let i=0;i<20;i++) mk('TE', 35);
  for (let i=0;i<15;i++) mk('K', 10); for (let i=0;i<15;i++) mk('DST', 10);
  const roster = [{id:'w1',pos:'WR'},{id:'w2',pos:'WR'},{id:'w3',pos:'WR'},{id:'q',pos:'QB'}]; // WR-heavy, RB still a need
  const { candidates } = recommend(ps, new Set(Array.from({length:40},(_,i)=>`t${i}`)), roster, settings, 5, []);
  const idx = candidates.findIndex(c=>c.name==='WR-VALUE-LEADER');
  const inTop12ByScore = candidates.slice(0,12).some(c=>c.name==='WR-VALUE-LEADER');
  console.log(`   WR-VALUE-LEADER present at shortlist index ${idx} (in top-12-by-score: ${inTop12ByScore})`);
  check('the WR value leader would be dropped by top-12-by-score alone', !inTop12ByScore);
  check('the WR value leader is still in the returned shortlist (unioned in)', idx >= 0);
}

// ============================================================================
// PART 11 — Reach-headline honesty (regression for the Josh Allen bug: the "My pick" headline hardcoded
// "an elite value falling past his ADP, worth the reach" on the reach flag alone, so a player taken AHEAD
// of his ADP was falsely called a faller). reachSuffix() must word the line from the pick's real adpDelta:
// ahead-of-ADP reads as a reach ahead of ADP (never "falling"), a genuine faller reads as fallen past ADP,
// and around-ADP / no-ADP asserts no direction. The exact Allen numbers (pick 20, ADP 26.6 -> delta ~-7).
// ============================================================================
console.log('\nPART 11 — reach-headline honesty (worded from actual adpDelta, no false "falling" claim)');
{
  const ahead   = reachSuffix({ pos:'QB', adpDelta:-7 });   // Josh Allen: pick 20, ADP 26.6 -> taken ahead of ADP
  const faller  = reachSuffix({ pos:'RB', adpDelta: 8 });    // genuinely slid past his ADP
  const around  = reachSuffix({ pos:'WR', adpDelta: 1 });    // right around ADP
  const noAdp   = reachSuffix({ pos:'TE', adpDelta: null }); // no ADP data
  const roto    = reachSuffix({ pos:'C',  adpDelta: null }, { roto:true });
  console.log('   ahead-of-ADP :', JSON.stringify(ahead));
  console.log('   faller       :', JSON.stringify(faller));
  console.log('   around ADP   :', JSON.stringify(around));
  console.log('   no ADP data  :', JSON.stringify(noAdp));
  console.log('   roto         :', JSON.stringify(roto));
  const claimsFalling = (s) => /fall(en|ing)|past his ADP/i.test(s);
  check('an AHEAD-of-ADP reach is NOT called "falling past his ADP" (the Allen bug)', !claimsFalling(ahead));
  check('an ahead-of-ADP reach reads as a reach ahead of his ADP', /ahead of his ADP/i.test(ahead));
  check('a genuine faller IS described as fallen past his ADP', /fallen \d+ picks past his ADP/i.test(faller));
  check('an around-ADP reach asserts no ADP direction (no false claim)', !claimsFalling(around) && !/ahead of his ADP/i.test(around));
  check('a no-ADP-data reach asserts no ADP direction', !claimsFalling(noAdp) && !/ahead of his ADP/i.test(noAdp));
  check('roto keeps its all-around wording (no ADP framing)', /clearly superior all-around/.test(roto) && !claimsFalling(roto));
}

// ============================================================================
// PART 12 — Reach-flag overload on the board tag (second surface of the Allen bug). The coarse board-row
// reason used to be `reach ? 'value' : ...`, tagging ANY off-need reach "top value". pickReasonTag() must
// resolve reach against the pick's adpDelta: 'value' only for a genuine faller, else 'reach'; non-reach
// picks keep forced/need/value. So the tag and the headline (reachSuffix) can never disagree.
// ============================================================================
console.log('\nPART 12 — reach-flag overload (board tag honest to adpDelta, not blanket "value")');
{
  const aheadReach = pickReasonTag({ adpDelta:-7 }, { reach:true });               // Allen: off-need reach, ahead of ADP
  const fallerReach = pickReasonTag({ adpDelta: 8 }, { reach:true });              // off-need reach on a genuine faller
  const aroundReach = pickReasonTag({ adpDelta: 1 }, { reach:true });              // off-need reach, right around ADP
  const forcedPick  = pickReasonTag({ forced:true, need:true, adpDelta:null }, { reach:false });
  const needPick    = pickReasonTag({ need:true, adpDelta:null }, { reach:false });
  const valuePick   = pickReasonTag({ adpDelta:null }, { reach:false });           // normal best-available
  console.log('   reach+ahead:', aheadReach, '| reach+faller:', fallerReach, '| reach+around:', aroundReach,
              '| forced:', forcedPick, '| need:', needPick, '| plain:', valuePick);
  check('an off-need reach AHEAD of ADP tags as "reach", not "value" (the Allen bug)', aheadReach === 'reach');
  check('an off-need reach on a genuine faller still tags as "value"', fallerReach === 'value');
  check('an off-need reach around ADP tags as "reach"', aroundReach === 'reach');
  check('a forced late pick still tags as "must-fill"', forcedPick === 'must-fill');
  check('a need pick still tags as "need"', needPick === 'need');
  check('a normal best-available pick tags as "value"', valuePick === 'value');
}

// ============================================================================
// PART 13 — Scarcity line excludes K/DST (regression for the misleading "QB is scarcest alongside DST/K"
// rationale). K/DST have near-random value, so their startable counts are tiny and would sort to the FRONT
// of a fewest-first list, letting the analyst pair them with a genuinely scarce QB/TE and imply early
// urgency. scarcityLine() must drop them entirely, keep skill positions fewest-first, and their late-round
// timing is handled elsewhere (ROSTER NECESSITY). Roto pools (no K/DST) are unaffected.
// ============================================================================
console.log('\nPART 13 — scarcity line excludes K/DST (no false early-urgency signal)');
{
  // DST/K have the smallest counts (would otherwise lead the fewest-first list ahead of QB/TE).
  const startableLeft = { DST:1, K:2, QB:4, TE:5, WR:8, RB:9 };
  const line = scarcityLine(startableLeft);
  console.log('   scarcityLine:', JSON.stringify(line));
  check('no K in the scarcity line', !/\bK\b/.test(line));
  check('no DST in the scarcity line', !/DST/.test(line));
  check('skill positions kept, fewest first (QB leads)', line === 'QB 4, TE 5, WR 8, RB 9');
  // A pool where only K/DST are "startable" must not manufacture a scarcity claim.
  check('only-K/DST board yields no scarcity list (n/a)', scarcityLine({ K:3, DST:2 }) === 'n/a');
  check('empty/absent board yields n/a', scarcityLine({}) === 'n/a' && scarcityLine(null) === 'n/a');
  // Roto-style pool (no K/DST) is untouched — every position survives, fewest first.
  check('roto pool (no K/DST) is unaffected', scarcityLine({ C:2, PG:5, SG:7 }) === 'C 2, PG 5, SG 7');
}

// ============================================================================
// PART 14 — ADP-fit magnitude honesty (regression for the hardcoded "a slight reach"). describeNfl's
// ADP-fit clause used to call EVERY ahead-of-ADP name "a slight reach" regardless of the gap, so a
// 25-pick overpay read the same as a 3-pick one. adpFitPhrase() must size the reach against a full round
// (`teams` picks): a gap of a full round or more is "a notable reach", a smaller one stays "a slight
// reach". The value side and the "right around his ADP" band are unchanged, and a null delta yields no
// clause. teams = 12 here (a full round).
// ============================================================================
console.log('\nPART 14 — ADP-fit magnitude honesty (big reach reads "notable", not "slight")');
{
  const T = settings.teams; // 12 -> a full round is 12 picks
  const bigReach   = adpFitPhrase(-25, T);  // the reported bug: 25 picks ahead of ADP (>2 rounds)
  const fullRound  = adpFitPhrase(-T,  T);  // exactly a full round ahead -> notable (boundary)
  const smallReach = adpFitPhrase(-4,  T);  // under a round ahead -> still slight
  const value      = adpFitPhrase(9,   T);  // still on the board past ADP
  const around     = adpFitPhrase(1,   T);  // right around ADP
  const noDelta    = adpFitPhrase(null,T);  // no ADP data -> no clause
  console.log('   -25 :', JSON.stringify(bigReach));
  console.log('   -12 :', JSON.stringify(fullRound));
  console.log('   -4  :', JSON.stringify(smallReach));
  console.log('    +9 :', JSON.stringify(value));
  console.log('    +1 :', JSON.stringify(around));
  console.log('   null:', JSON.stringify(noDelta));
  check('a full-round-plus reach reads "a notable reach", not "slight" (the bug)', /25 picks ahead of his ADP \(a notable reach\)/.test(bigReach) && !/slight/.test(bigReach));
  check('exactly a full round ahead is already "notable" (boundary is inclusive)', /a notable reach/.test(fullRound));
  check('an under-a-round reach still reads "a slight reach"', /4 picks ahead of his ADP \(a slight reach\)/.test(smallReach));
  check('the value side is unchanged (still on the board past ADP)', value === 'still on the board 9 picks past his ADP (a value)');
  check('the around-ADP band is unchanged', around === 'right around his ADP');
  check('a null delta yields no clause (caller omits it)', noDelta === null);
  // Without a teams count there's no round length to compare against -> falls back to "slight" (never crashes).
  check('missing teams falls back to "slight" (no round length to size against)', /a slight reach/.test(adpFitPhrase(-25)));
}

// ============================================================================
// PART 17 — K/DST v1+v2 enrichment: pick a BETTER K/DST within the late window (WHICH, not WHEN). Two halves:
// (A) the pure signal builder kdstForPlayer() composes projection anchor + kicker offense rank/dome/job
// security AND (v2) the DST's OWN defense rank into one label; (B) the Coach draft-context surfaces that
// label for K/DST rows in the late-round
// window ONLY — never earlier — so timing (SCARCITY_SKIP_POS / VORP) is untouched and this is purely which.
// ============================================================================
console.log('\nPART 17 — K/DST enrichment picks a better K/DST within the window (which, not when)');
{
  // (A) Pure builder. Two teams: MIN (dome, mid offense #6) and BUF (outdoor, top offense #1).
  const tc = { '1': { abbr:'MIN', offenseRank:6, defenseRank:3, teamsRanked:32 }, '2': { abbr:'BUF', offenseRank:1, defenseRank:20, teamsRanked:32 } };
  const depthMap = {
    [keyFor('K','Will Reichard')]: { order:1, competition:false, injury:null },        // locked starter
    [keyFor('K','Camp Legman')]:   { order:null, competition:true, injury:null },       // unranked, contested
  };
  const leadK = kdstForPlayer({ pos:'K', name:'Will Reichard', teamId:'1', proj:{fpts:148} }, tc, depthMap);
  const compK = kdstForPlayer({ pos:'K', name:'Camp Legman', teamId:'2', proj:{fpts:150} }, tc, depthMap);
  const dst   = kdstForPlayer({ pos:'DST', name:'Vikings D/ST', team:'MIN', proj:{fpts:120} }, tc, depthMap);           // no teamId join
  const dstRanked = kdstForPlayer({ pos:'DST', name:'Vikings D/ST', teamId:'1', team:'MIN', proj:{fpts:120} }, tc, depthMap); // v2: joins teamContext
  const rb    = kdstForPlayer({ pos:'RB', name:'Some Back', proj:{fpts:250} }, tc, depthMap);
  console.log('   leadK:', JSON.stringify(leadK.label));
  console.log('   compK:', JSON.stringify(compK.label));
  console.log('   dst  :', JSON.stringify(dst.label), '| dstRanked:', JSON.stringify(dstRanked.label));
  check('lead kicker label fuses projection + offense rank + dome + lead-K', leadK.label === 'proj 148 pts · MIN offense #6 · dome · lead K');
  check('a contested kicker reads as a competition, not a lock', /in a K competition/.test(compK.label) && !/lead K/.test(compK.label));
  check('outdoor top-offense kicker shows the rank but no dome', /BUF offense #1/.test(compK.label) && !/dome/.test(compK.label));
  check('DST with no team join falls back to projection only', dst.label === 'proj 120 pts' && dst.defenseRank === null && dst.offenseRank === null && dst.jobRole === null);
  check('DST v2 fuses projection + its OWN defense rank (which DST, not when)', dstRanked.label === 'proj 120 pts · MIN defense #3' && dstRanked.defenseTier === 'top' && dstRanked.offenseRank === null && dstRanked.jobRole === null);
  check('a skill player gets no kdst signal', rb === null);

  // (B) Coach context surfaces the label in the LATE window and NOT before (timing unchanged).
  const K1 = { id:'k1', pos:'K', name:'Will Reichard', fpPpr:130, kdst: leadK };
  const D1 = { id:'d1', pos:'DST', name:'Vikings D/ST', fpPpr:120, kdst: dstRanked };
  const R1 = { id:'r1', pos:'RB', name:'Bijan Robinson', fpPpr:340, proj:{fpts:340}, adp:{ppr:2} };
  const pool = [R1, K1, D1];
  const byId = new Map(pool.map(p => [p.id, p]));
  const rankMap = new Map([['r1',1],['k1',150],['d1',160]]);
  const mkState = (pickIndex) => ({
    mode:'mock', format:'standard', userTeam:0, pickIndex, totalPicks:180,
    settings:{ teams:12, rounds:15, scoring:'ppr', starters:{QB:1,RB:2,WR:2,TE:1,FLEX:1,K:1,DST:1} },
    drafted:new Set(), roster:[{id:'r1',pos:'RB'}], picks:[],
  });
  const build = (pickIndex) => buildDraftContext({
    state: mkState(pickIndex), players: pool, byId, rankMap, lastBoard: null, lastReco: null, lastCandidates: [],
    isRoto:false, rotoLabel:null,
    roundOf:(i,teams)=>Math.floor(i/teams)+1,
    boardCmp:(a,b)=>(rankMap.get(a.id)??1e9)-(rankMap.get(b.id)??1e9),
    adpFor, nflFpts,
  });
  const late = build(156); // round 14 of 15 -> late K/DST window
  const early = build(0);  // round 1 -> K/DST must NOT surface
  console.log('   late K line present:', /K — Will Reichard/.test(late), '| early K present:', /Will Reichard/.test(early));
  check('late window surfaces the kicker enrichment label to the Coach', late.includes('Will Reichard (proj 148 pts · MIN offense #6 · dome · lead K)'));
  check('late window surfaces the DST defense-rank label to the Coach (v2)', late.includes('Vikings D/ST (proj 120 pts · MIN defense #3)'));
  check('late window nudges toward the stronger K/DST (which, not when)', /prefer the stronger option on these signals/.test(late) && /not drafting them earlier/.test(late));
  check('K/DST are still gated to the late window (they never surface in round 1)', !/Will Reichard/.test(early) && !/Vikings D\/ST/.test(early));

  // (C) THE no-bleed proof the feature promised: attaching p.kdst must change NOTHING but the K/DST
  //     annotation. Not a proxy — a byte-identical before/after diff on both surfaces.
  //  C1) Engine: recommend()'s picks/order/scores are byte-identical with vs without p.kdst on the K/DST rows
  //      (kdstLabel is threaded through but must never enter the sort/score — see draft.js line ~578/601).
  const mkPool = (withKdst) => {
    const P = []; const mk = (pos,i,fp) => P.push({ id:`${pos}${i}`, name:`${pos}-${i}`, team:'X', pos, rank:P.length+1, fpPpr:fp, proj:{fpts:fp} });
    for (let i=1;i<=24;i++) mk('QB', i, 360 - i*7);
    for (let i=1;i<=40;i++) mk('RB', i, 330 - i*5);
    for (let i=1;i<=40;i++) mk('WR', i, 310 - i*5);
    for (let i=1;i<=16;i++) mk('TE', i, 200 - i*6);
    for (let i=1;i<=16;i++) mk('K',   i, 150 - i*4);
    for (let i=1;i<=16;i++) mk('DST', i, 150 - i*4);
    if (withKdst) for (const p of P) if (p.pos === 'K' || p.pos === 'DST') p.kdst = { label: `proj ${p.fpPpr} pts`, projFpts: p.fpPpr };
    return P;
  };
  const rosterC = [ {id:'q',pos:'QB'},{id:'r1',pos:'RB'},{id:'r2',pos:'RB'},{id:'w1',pos:'WR'},{id:'w2',pos:'WR'} ];
  const engineSig = (P) => recommend(P, new Set(), rosterC, settings, 8, [])
    .candidates.map(c => `${c.pos}:${c.id}:${c.score}:${c.vorp}:${c.rank}`).join('|');
  const engineNo = engineSig(mkPool(false));
  const engineYes = engineSig(mkPool(true));
  check('attaching p.kdst does NOT change recommend() picks/order/score at all (no scoring bleed)', engineNo === engineYes);

  //  C2) Coach context: the ONLY difference between enriched and un-enriched output is the K/DST label text
  //      + the one guidance sentence. Strip those two things from the enriched output and it must be
  //      byte-identical to the un-enriched output — proving the QB/RB/WR/TE board, roster line, caps, and
  //      everything else are untouched.
  const strip = (p) => ({ ...p, kdst: undefined });
  const poolNo = [R1, strip(K1), strip(D1)];
  const byIdNo = new Map(poolNo.map(p => [p.id, p]));
  const lateNo = buildDraftContext({
    state: mkState(156), players: poolNo, byId: byIdNo, rankMap, lastBoard: null, lastReco: null, lastCandidates: [],
    isRoto:false, rotoLabel:null,
    roundOf:(i,teams)=>Math.floor(i/teams)+1,
    boardCmp:(a,b)=>(rankMap.get(a.id)??1e9)-(rankMap.get(b.id)??1e9),
    adpFor, nflFpts,
  });
  const GUIDE = ' For K/DST, prefer the stronger option on these signals (projection, offense/defense rank, dome, kicker job security) — this is about WHICH one, not drafting them earlier.';
  const lateStripped = late.replace(GUIDE, '').replace(/ \(proj[^)]*\)/g, ''); // remove the two K/DST-only additions
  check('the ONLY change to the Coach context is the K/DST annotation + guidance; all else byte-identical', lateStripped === lateNo);
}

// ============================================================================
console.log('\n' + (results.every(r=>r.ok)
  ? `ALL ${results.length} CHECKS PASSED — VONA + TE flex-cap + round-1 gate + anti-hoard + context ownership + flex-worthy TE2 + flex-by-output + slot summary + endgame ADP decay + pool consistency + reach-headline honesty + reach-tag honesty + K/DST scarcity exclusion + ADP-fit magnitude honesty + K/DST v1/v2 enrichment (which K/DST, incl. DST defense rank) behave as shipped.`
  : `FAILURES: ${results.filter(r=>!r.ok).map(r=>r.name).join('; ')}`));
process.exit(results.every(r=>r.ok) ? 0 : 1);
