// ESPN team id -> CFBD school name.
//
// WHY THIS EXISTS. The Pick'em feed is keyed on ESPN team ids from end to end, and CFBD carries no
// ESPN id on any endpoint — its `Team` is `{ id, school, mascot, abbreviation, alternateNames, … }`
// where `id` is CFBD's own. So the two datasets can only be joined on names, and college football
// names are the worst case for that: the same school is "App State" to ESPN and "Appalachian
// State" to CFBD, there are two Miamis, and half the Group of Five goes by initials that each
// source expands differently.
//
// RESOLVED AT RUN TIME, NOT COMMITTED. A hand-written 136-row table would be wrong the first time
// a school rebrands or a team moves up from FCS, and wrong silently. Instead the match is computed
// from `/teams/fbs` (ONE call, all teams, cached in Redis afterwards) against the ESPN names
// already on the slate, through a normalise-then-cascade matcher. The alias table below is only
// for pairs that no amount of normalising will bring together.
//
// UNMATCHED TEAMS ARE REPORTED, never swallowed. `buildCrosswalk` returns the misses, the ratings
// build puts the count in its payload and the cron prints it. This codebase has been bitten twice
// by joins that failed into an empty map and looked like healthy-but-quiet data (see the injuries
// note in pickem.js); a name join is exactly that failure mode waiting to happen.
//
// THE MATCH RUNS FROM CFBD TOWARD ESPN, not the other way round, and the direction is the whole
// point of the miss report. ESPN's team endpoint lists every division — some 400 schools, most of
// them FCS or Division II — so iterating ESPN would report a couple of hundred "unmatched" teams
// that were never supposed to match, and a real failure would be invisible inside that noise.
// CFBD's FBS list is ~136 teams that should ALL resolve, so a non-empty miss list is unambiguously
// a bug, and each name on it is exactly one school whose cards lost their model line.

// Pairs normalisation cannot fix: ESPN's spelling on the left, CFBD's `school` on the right.
// Deliberately short — anything that normalises cleanly must NOT be listed here, or the table
// becomes a second source of truth that rots.
const ALIAS = {
  'app state': 'appalachian state',
  'southern miss': 'southern mississippi',
  'uconn': 'connecticut',
  'umass': 'massachusetts',
  'pitt': 'pittsburgh',
  'usf': 'south florida',
  'fiu': 'florida international',
  'fau': 'florida atlantic',
  'utsa': 'ut san antonio',
  'ul monroe': 'louisiana monroe',
  'ulm': 'louisiana monroe',
  'sam houston': 'sam houston state',
  'miami fl': 'miami',
  'nc state': 'nc state',
  'ole miss': 'ole miss',
};

// Lowercase, strip diacritics and punctuation, drop the words that carry no identity, and expand
// a trailing "St" to "State" — "San Jose St" and "San José State" have to land on one string.
export function normalizeName(s) {
  if (!s) return '';
  let x = String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  x = x.replace(/['’`]/g, '').replace(/[().]/g, ' ').replace(/[-–—/]/g, ' ').replace(/&/g, ' and ');
  x = x.replace(/\buniversity\b|\buniv\b/g, ' ');
  x = x.replace(/\s+/g, ' ').trim();
  x = x.replace(/\bst\b/g, 'state');
  return x.replace(/\s+/g, ' ').trim();
}

const alias = (n) => ALIAS[n] || n;

// Every string that could reasonably identify one CFBD team.
function cfbdKeys(t) {
  const out = new Set();
  for (const s of [t.school, ...(t.alternateNames || [])]) {
    const n = normalizeName(s);
    if (n) { out.add(n); out.add(alias(n)); }
  }
  return out;
}

// Every string ESPN offers for one team, in descending order of how specific it is. `location` is
// the school without the mascot and is the closest analogue to CFBD's `school`, so it leads;
// abbreviation trails because "BSU" is Boise State, Buffalo State, Bowie State and Ball State
// depending on who is asking, and matching on it first would pick whichever loaded earlier.
function espnKeys(team) {
  const cands = [team.location, team.displayName, team.shortDisplayName]
    .filter(Boolean)
    .map(normalizeName)
    .filter(Boolean);
  return [...new Set(cands.flatMap((n) => [alias(n), n]))];
}

// Build { espnId: cfbdSchool }, plus the CFBD schools that found no ESPN team.
//   espnTeams — [{ id, location, displayName, shortDisplayName, name, abbreviation }] (any division)
//   cfbdTeams — CFBD /teams/fbs rows
export function buildCrosswalk(espnTeams, cfbdTeams) {
  // ESPN index. First writer wins per key, and the candidate order in espnKeys is what makes that
  // safe: `location` is checked before nicknames, so "Miami" resolves to the Hurricanes rather than
  // to whichever school happens to carry Miami in a secondary field.
  const byKey = new Map();
  for (const e of (espnTeams || [])) {
    if (!e?.id) continue;
    for (const k of espnKeys(e)) if (!byKey.has(k)) byKey.set(k, String(e.id));
  }
  const map = {}, unmatched = [];
  for (const t of (cfbdTeams || [])) {
    if (!t?.school) continue;
    let hit = null;
    for (const k of cfbdKeys(t)) { if (byKey.has(k)) { hit = byKey.get(k); break; } }
    // An ESPN id must never carry two schools. If one is already claimed, the second school is a
    // miss rather than an overwrite — silently reassigning it would put one team's ratings on
    // another team's card, which is worse in every way than having no model line at all.
    if (hit && !map[hit]) map[hit] = t.school;
    else unmatched.push({ school: t.school, reason: hit ? 'espn id already claimed' : 'no espn match' });
  }
  return { map, unmatched, matched: Object.keys(map).length };
}
