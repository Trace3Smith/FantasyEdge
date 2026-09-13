# Sanitized authenticated ESPN roster evidence

Captured 2026-09-12 with local authentication using existing discoverFanLeagues and fetchLeagueRoster.
The latter checked that the discovered team is owned by the authenticated account before saving anything.
No lineup writes, Redis reads/writes, credential migration or provider transaction requests occurred.

| Fixture | Discovery season | Roster season | Players | Scoring |
|---|---|---|---|---|
| nba-2027.json | 2027 | 2027 | 0 | ROTO |
| nba-2026.json | 2027 | 2026 | 15 | ROTO |
| nhl-2027.json | 2027 | 2027 | 0 | ROTO |
| nhl-2026.json | 2027 | 2026 | 22 | ROTO |

The historical requests reused the discovered league/team IDs and independently passed ownership checks.
They do not establish that fan discovery returned 2026 entries. Empty upcoming rosters must not produce
an All Clear assessment. Historical populated rosters are parser evidence, not current recommendations.

Projection/scrubbing: retain only target-sport fan preferences needed for discovery, technical IDs, numeric/
boolean/null settings, scoringType, selected team's player entries and other teams' numeric IDs/ownership.
Replace all owner identifiers consistently with deterministic synthetic GUIDs (fixture-local, not hashes).
The fixture owner field is synthetic. Drop personal/team names, members, account information, logos,
private URLs, cookies, unrelated rosters and unreviewed settings strings. Athlete fullName is public player
identity, retained for name joins. Original raw bodies stayed in memory. Captured files were checked for
actual cookie/owner residues before saving and again before staging, without printing those values.

NBA: all five position IDs appear; populated slots 0–6, 11, 12, 13. Captured roster counts include zero
slots 7–10 and 14: do not infer semantics from a zero count. NBA default position labels and bench12/IR13
classification are tested. Five players report OUT; ten ACTIVE. An IR occupant need not report the literal
INJURY_RESERVE status. This does not prove IR activation eligibility or legality of any move.

NHL: position IDs 1–5; populated slots 3,4,5,6,7; configured slots also include 8. Statuses include ACTIVE,
OUT and SUSPENSION. IDs and eligibility are preserved exactly, but response data has no authoritative
human slot-name registry. Current NHL parser still lacks position/slot/bench maps and can misclassify
reserves as starters. Tests deliberately verify raw data preservation and capability restrictions without
certifying those incorrect semantics. C/LW/RW/D, goalie/flex/reserve labels and IR+ require further evidence.

All captured entries include selected provider lock fields. This proves their shape and parser handling,
not present-day lock state, daily/weekly rules, or transaction rejection behavior. Missing-field behavior
is tested separately with synthetic data. No points league, co-owner-specific live scenario, provider team
abbreviation registry, stat-label registry or transaction fixture has been captured.

`npm run check:sport-readiness` now replays these fixtures offline through the actual discovery and roster
functions, checks denied ownership, preserves numeric scoring/eligibility/injury/lock evidence, and keeps
NBA/NHL recommendation/write/Autopilot gates closed. Synthetic tests are labeled separately. Read-only
UI rollout and Advisor aggregation remain pending semantic and freshness coverage; no enablement claim.
