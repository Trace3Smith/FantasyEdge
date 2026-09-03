// MLB injury designations, from MLB's own Stats API rather than ESPN's injuries feed.
//
// WHY A SEPARATE SOURCE. Every other board joins ESPN injuries on the ESPN athlete id, but the MLB
// pool is built from statsapi.mlb.com, so p.id is an MLBAM id (691718 = Pete Crow-Armstrong). The
// ESPN join produces ZERO hits against 716 players — measured, not assumed. Going native instead of
// bolting on a crosswalk gives an exact join on the id we already have: 704 of 716 matched.
//
// The status vocabulary is MLB's own and richer than ESPN's, with stable codes:
//   D60 Injured 60-Day · D15 Injured 15-Day · D10 Injured 10-Day · D7 Injured 7-Day
//   ILF Injured - Full Season · RA Rehab Assignment · SU Suspended
//
// Scoped to injuries plus suspension, matching what the other boards surface. Deliberately NOT
// carried: RM (Reassigned to Minors, 33 of our pool), DEV, RES, TAX, NYR, DES, TI — those are roster
// mechanics, not injuries, and a demoted player is a different signal that deserves its own
// treatment rather than being smuggled in under an injury badge.
//
// Also not carried: RST (Restricted List), ADM (Administrative Leave), IN (Ineligible List). Those
// are off-field designations, and league-wide they land on 26 players, NONE of whom are in our pool
// — every one is a minor leaguer. So including them would buy nothing and would put the app in the
// position of surfacing an off-field status about a real person. If that ever changes the decision
// should be made deliberately, not inherited from this scoping.
//
// One honest gap versus the ESPN sports: statsapi's roster carries no body part and no return date
// (hydrate=person(injuries) does not populate them either), so MLB records are status-only. The
// renderers already degrade to just the badge when detail is absent.
const API = 'https://statsapi.mlb.com/api/v1';

// MLB status code -> the same record shape the ESPN sports produce, so applyInjuries is shared.
const MAP = {
  D60: { code: 'INJURY_STATUS_60DAYIL', abbr: 'IL60' },
  D15: { code: 'INJURY_STATUS_15DAYIL', abbr: 'IL15' },
  D10: { code: 'INJURY_STATUS_10DAYIL', abbr: 'IL10' },
  D7:  { code: 'INJURY_STATUS_7DAYIL',  abbr: 'IL7'  },
  ILF: { code: 'INJURY_STATUS_FULLSEASONIL', abbr: 'ILF' },
  RA:  { code: 'INJURY_STATUS_REHAB',   abbr: 'RA'   },
  SU:  { code: 'INJURY_STATUS_SUSPENSION', abbr: 'SUSP' },
};

// Pure code -> record mapper, exported so the scoping decision above is testable rather than buried
// in a constant. An unmapped code (roster mechanics, or an off-field designation) returns null and is
// never attached to a player.
export function mlbStatusToInjury(code, description) {
  const m = MAP[code];
  if (!m) return null;
  return { code: m.code, abbr: m.abbr, status: description || null, detail: null, returnDate: null, date: null };
}

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

// mlbamId -> injury record. Uses rosterType=fullRoster deliberately: the 40-man roster the dataset
// itself is built from EXCLUDES 60-day IL players (freeing that spot is the point of the 60-day IL),
// which is exactly the group most worth flagging. Failure-tolerant — an empty map flags nobody.
export async function fetchMlbInjuries(season = new Date().getFullYear()) {
  const index = new Map();
  try {
    const teams = (await getJson(`${API}/teams?sportId=1&season=${season}`))?.teams || [];
    const results = await Promise.all(teams.map(async (t) => {
      try {
        const j = await getJson(`${API}/teams/${t.id}/roster?rosterType=fullRoster&season=${season}`);
        return j?.roster || [];
      } catch { return []; }
    }));
    for (const roster of results) {
      for (const r of roster) {
        const rec = mlbStatusToInjury(r?.status?.code, r?.status?.description);
        if (!rec || r?.person?.id == null) continue;
        index.set(String(r.person.id), rec);
      }
    }
  } catch { /* no injuries this build */ }
  return index;
}
