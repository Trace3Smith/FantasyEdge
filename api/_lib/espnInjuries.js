// Shared ESPN injury designations — one implementation for every sport that has an ESPN-sourced
// player pool (NFL, NBA, WNBA, NHL). Verified against live data for all four: the feed exists in the
// same shape everywhere, and body-part detail + return date are present on 100% of entries outside
// the NFL (the NFL fills those on ~48%).
//
// KEYED ON type.name, NOT the free-text `status`. This is the whole reason this module exists. The
// display strings diverge sharply per sport while the structured code does not:
//
//   NFL   Active/A · Injured Reserve/IR · Questionable/Q · Out/O · Suspension/SUSP
//   NBA   Day-To-Day/DD · Out/O
//   NHL   Out/O · Injured Reserve/IR · Suspension/SUSP · Day-To-Day/DD
//   WNBA  Out/O
//   MLB   60-Day-IL/IL60 · 15-Day-IL/IL15 · 10-Day-IL/IL10 · 7-Day IL/IL7 · Day-To-Day/DD · suspension/SUSP
//
// An allowlist over `status` (what the first NFL-only version used) silently dropped every MLB entry
// and 67 of 76 NBA ones, and MLB spells suspension lowercase where the NFL capitalises it. type.name
// collapses all of that: INJURY_STATUS_SUSPENSION either way.
//
// So the filter is a DENYLIST of one: everything is shown except INJURY_STATUS_ACTIVE. A designation
// we have never seen is surfaced rather than silently swallowed — the failure mode that hid MLB.
//
// MLB is deliberately absent from this module's callers: its pool is built from statsapi.mlb.com, so
// p.id is an MLBAM id, and the ESPN id join produces ZERO hits. It needs its own native source.
import { getJson } from './espn.js';

const INJURIES_URL = (sportPath) => `https://site.web.api.espn.com/apis/site/v2/sports/${sportPath}/injuries`;
// The entries carry no athlete.id field at all — the id exists only inside athlete.links
// (…/player/_/id/<id>/…), so it is parsed from there rather than falling back to name matching.
const LINK_ID = /\/id\/(\d+)/;
const NOT_AN_INJURY = new Set(['INJURY_STATUS_ACTIVE']); // "Active" here means recovered, not hurt

// athleteId -> record. Failure-tolerant: an empty map just means nothing is flagged this build.
export async function fetchInjuries(sportPath) {
  const index = new Map();
  try {
    const j = await getJson(INJURIES_URL(sportPath));
    for (const t of (j?.injuries || [])) {
      for (const e of (t?.injuries || [])) {
        const href = (e?.athlete?.links || []).map((l) => l?.href).find((h) => LINK_ID.test(h || ''));
        const m = href && LINK_ID.exec(href);
        if (!m) continue;
        index.set(m[1], {
          code: e.type?.name || null,        // INJURY_STATUS_* — the stable cross-sport key
          status: e.status || null,          // sport-specific display string ("15-Day-IL")
          abbr: e.type?.abbreviation || null, // IR | Q | O | DD | SUSP | IL60 …
          // ESPN fills unknown sub-fields with the literal "Not Specified"/"Undisclosed", which reads
          // as noise beside a real body part ("Head Not Specified"), so those are dropped.
          detail: [e.details?.type, e.details?.detail]
            .filter((x) => x && x !== 'Not Specified' && x !== 'Undisclosed').join(' ') || null,
          returnDate: e.details?.returnDate || null,
          date: e.date || null,
          // shortComment (a sourced beat-writer line) is deliberately NOT carried. Status, body part
          // and return date are official designations and safe to state; a quoted report is
          // journalism, and some entries cover personal or off-field matters where restating a
          // sentence about a real person is a different order of risk. Link out, never paraphrase.
        });
      }
    }
  } catch { /* no injuries this build */ }
  return index;
}

// Pure merge. Attaches p.injury for any designation that is not "recovered", and CLEARS a stale one
// when a player has returned — otherwise a healed player stays badged Out forever.
export function applyInjuries(players, index) {
  let flagged = 0, cleared = 0;
  for (const r of players || []) {
    if (r.pos === 'DST') continue; // a DST is a team, not a person
    const e = index && index.get(String(r.id));
    const show = e && e.code && !NOT_AN_INJURY.has(e.code);
    if (show) { r.injury = e; flagged++; }
    else if (r.injury) { delete r.injury; cleared++; }
  }
  return { flagged, cleared };
}
