# Real ESPN league settings payloads

Captured from live ESPN leagues with `npm run capture:league-settings`, one per sport. These are what
`espnLeagueConfig.js` is asserted against in `scripts/check-league-config.mjs`, so the adapter is
pinned to what ESPN actually sends rather than to what we assumed it sends.

Each file is the `settings` object of a `view=mSettings` response, trimmed to the blocks the adapter
reads (`name`, `size`, `scoringSettings`, `draftSettings`, `acquisitionSettings`, `tradeSettings`) and
otherwise verbatim — field order, stray keys, odd values and all. Do not tidy them up: a value that
looks wrong is usually the point. `acquisitionBudget: 100` sitting next to
`isUsingAcquisitionBudget: false` is the clearest example — four of these five leagues carry a budget
they do not use, and reading it directly would invent FAAB where there is none.

They contain no member names, member ids or SWIDs: `view=mSettings` carries none, which was checked
across all five at capture time. Anything captured from the draft or transaction views will NOT be
clean in the same way and must be scrubbed before it is committed here.

To refresh or add one:

    ESPN_S2='...' SWID='{...}' npm run capture:league-settings -- nfl
    cp tmp/league-settings/nfl-<id>-<season>.fixture.json scripts/fixtures/league-settings/nfl-<id>-<season>.json

then update the expectations in check-league-config.mjs if the new league differs from the old one.
