# Prospective SP+ history

The daily refresh cron records its already-fetched CURRENT SP+ response. This costs zero additional
CFBD requests; the existing year-level budget and cron-only ratings ownership are unchanged. No feed
request, historical fit, extra week endpoint or per-team request is introduced.

`buildCfbRatings` supplies an optional `onSpObserved` callback with the exact source rows, source season,
basis and observation timestamp after the response is received. The cron retains it only in memory,
then uses the existing CFB regular/bowl feed's ESPN season/type/week identity. This avoids inventing a
week from the calendar or trying a nonexistent historical SP+ week parameter. Snapshot storage failures
are reported separately in each feed's `spSnapshot` summary and do not fail the feed.

Keys: `ratings:cfb:sp:snapshot:v1:{season}:{seasonType}:{week}`. Season types 2 and 3 are separate.
Redis `SET NX`, without TTL, preserves the FIRST usable observation for that week, including across
concurrent cron runs. Subsequent responses never replace it with a more informed rating. The first run
may occur midweek: this is incomplete prospective coverage, not pregame evidence for earlier games.

Records retain raw SP+ rows, normalized ratings/crosswalk/home-field parameter/version, observation and
recording timestamps, and a manifest of known future pregame matchups from the already-built slate.
Source publication time is explicitly unknown; an observation time is not CFBD's publication time.
The market spread is retained when available, under the explicit **home handicap** convention: negative
means home favored. Never treat this as nflverse's opposite convention or as a closing market line.

Reject prior-season fallback, mismatched source/ratings/slate years, malformed week, absent usable team
or crosswalk data, invalid/future timestamps, responses older than six hours within the cron, and slates
without an identifiable future pregame matchup. The conservative cutoff is recording time (after the
feed build), not just response receipt: a game that started while the feed was building is excluded.
A skipped week stays missing. Do not repair missing history with a later `/ratings/sp?year=...` response.

## Future grading contract

A stored record is a prospective observation, NOT successful validation. Grade only games with
independently verified actual kickoff AFTER BOTH observedAt and recordedAt, with matching season/type,
team identities and the captured pregame manifest. Handle reschedules conservatively and exclude ambiguous
kickoffs, missing joins or unsupported teams. Preserve a held-out evaluation protocol and sample counts.
Snapshot the market comparison from its real observation; never quietly substitute a postgame line.
First-seen midweek sampling and failed weeks must be disclosed, not counted as a full-season backtest.

The snapshot's probability/disagreement flags remain false. Neither storage nor sample accumulation
opens the product gates. The Elo backtest validates a structure, not SP+; historical end-of-season SP+
would leak results. Keep the four evidence decisions: college probability/disagreement closed; no
historical end-of-season SP+ validation; SP+-fitted home field 2.48 rather than Elo's 3.13; thin-market
advantage disproved. Neutral-site home field stays zero. Hawaii apostrophe normalization, Carolina's
raw-vs-adjusted assertion and spread-sign safeguards are untouched.

Verification: `npm run check:model` includes offline snapshot tests and the existing model tests
(nflverse read access required). `npm run check:brackets` exercises the existing real ESPN feeds and page.
No fit script, production cron, CFBD request, deployment or live fantasy mutation is needed to test this
unit. Only a later authorized deployment begins collecting real observations. Retention is intentional
historical research storage; do not expire or overwrite it during ordinary cache maintenance.
