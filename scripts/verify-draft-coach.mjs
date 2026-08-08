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

import { recommend, vonaScarcityClause, DEFAULT_SETTINGS } from '../api/_lib/draft.js';

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
console.log('\n' + (results.every(r=>r.ok)
  ? `ALL ${results.length} CHECKS PASSED — VONA clause + TE flex-cap behave as shipped.`
  : `FAILURES: ${results.filter(r=>!r.ok).map(r=>r.name).join('; ')}`));
process.exit(results.every(r=>r.ok) ? 0 : 1);
