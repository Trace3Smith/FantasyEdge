# Authenticated read-only fixture capture

Operator-only tool; never part of CI or a health check. No Redis access or ESPN writes.
Use locally stored ESPN_S2 and SWID in the ignored .env.local; never put values in chat or command
arguments. Preserve other environment entries. Restrict local file access to the owner.

Run `node --env-file=.env.local scripts/capture-readonly-fixture.mjs nba` first. After NBA validation,
run the same command with `nhl`. The script uses existing discovery and ownership-validated roster reads,
selects the latest discovered season, and saves only a sanitized projection to ignored
`tmp/readonly-fixtures/{sport}-{season}.json`. It does not enable any capability or modify application state.
An optional final season argument requests historical roster evidence for the discovered league;
discoveredSeason and requestedSeason remain separate in provenance. A failed discovery transport now
reports capture_stopped rather than falsely reporting no leagues. Discovery may use the existing fallback request. No unrelated provider hosts, redirects or writes allowed.

Raw responses stay in memory. User names, members, account details, logos and unrelated rosters are
omitted. Owner IDs are consistently replaced with synthetic IDs. Public athlete names and technical
player/team/league IDs remain. Settings retain numeric/boolean/null values plus scoringType; other
unreviewed strings are omitted. This is an explicitly reduced projection, not a verbatim provider payload.
The current entry projection targets the shared parser's playerPoolEntry shape. Inspect source-shape
coverage before claiming unusual provider entry variants are validated. Unknown numeric slot/stat values
are retained, not labeled by guesswork. Presence of lock flags is preserved where selected.

Before promoting a capture into tracked fixtures, review all remaining strings/keys and evidence coverage,
run the production parser against it offline, and add assertions for actual observed IDs, ownership,
settings, eligibility, injuries and missing fields. A preseason empty roster is not populated-roster
validation. Do not claim IR+, points leagues, transaction behavior or lock semantics without evidence.
The runtime also checks that known cookie/owner values do not survive serialization. This guard supplements
allowlist review; it does not establish that all third-party data is safe without inspection.

`node scripts/check-readonly-capture.mjs` tests sanitization with synthetic data only. Authenticated NBA/NHL 2027 and 2026 projections are now committed under
`scripts/fixtures/readonly-rosters/`; see their README for the evidence limits. Earlier configuration
attempts failed, but the subsequent local setup allowed successful authenticated captures.
