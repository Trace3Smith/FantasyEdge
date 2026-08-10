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

import { recommend, vonaScarcityClause, DEFAULT_SETTINGS, adpFor } from '../api/_lib/draft.js';
import { buildDraftContext } from '../draftContext.js';
import { nflFpts } from '../nflScoring.js';

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
console.log('\n' + (results.every(r=>r.ok)
  ? `ALL ${results.length} CHECKS PASSED — VONA + TE flex-cap + round-1 gate + anti-hoard + context ownership + flex-worthy TE2 + flex-by-output + slot summary behave as shipped.`
  : `FAILURES: ${results.filter(r=>!r.ok).map(r=>r.name).join('; ')}`));
process.exit(results.every(r=>r.ok) ? 0 : 1);
