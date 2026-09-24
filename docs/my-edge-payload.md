# My Edge Advisor: shared recommendations, pagination and UI

Implemented locally on my-edge-foundation; not deployed. POST /api/espn with
`{action: "myEdge", cursor?: "opaque continuation"}`. Existing Premium/Clerk authentication unchanged.
Response is private/no-store. No lineup writes, permission changes, research collection or persistent
snapshot cache. No NBA/NHL write/Autopilot allowlist changes.

## Shared source of truth

`api/_lib/recommendationSnapshot.js` owns the enrichment calculation used by Team Manager and My Edge:
parseScoringSettings → per-request scoring-signature buildValueIndex → categoryRanks → suggestLineup.
The Team Manager handler retains its existing scoring persistence and optional prospect/watch annotations.
My Edge performs neither write. Parity tests compare the shared snapshot with the original direct engine
call for identical inputs. No threshold, scoring weight, roster assignment or waiver formula was forked.
`lineupVacancies` exposes an occupancy diagnostic using the optimizer's existing activeOpenings rules,
with unknown roles/counts excluded. It does not propose a replacement independently.

My Edge's loader gates recommendations on existing ENGINE_SPORTS, populated known roster fields,
recognized scoring coverage/format, dataset timestamp <=30h, unique roster name joins with full value
coverage, and NFL bye data when applicable. It is deliberately stricter than Team Manager's historical
fallbacks. NBA ROTO cannot use basketball points valuations; NHL slot/reserve/category mappings remain
unsupported. Both retain basic READ_ONLY policy. NBA can surface verified availability and empty-slot
issues, but not optimizer-driven upgrades/IR/waivers. NHL unknown slots suppress slot-dependent advice.
This phase did not obtain new provider evidence or guess missing mappings.

One dataset/context per sport and one bye lookup per season per request. Eligible leagues fetch up to40
free-agent candidates via the existing shared reader. Waiver failure doesn't erase lineup advice; successful
candidate reads still do not establish exhaustive market coverage. Broader scoring/item overrides,
unrecognized categories or unknown player values yield PARTIAL rather than a default-valued confident
recommendation. A failed source is not an optimal lineup.

## Response shape

- schemaVersion:1, mode:ADVISOR, generatedAt.
- connectionState: CONNECTED, NO_LEAGUES, RECONNECT_REQUIRED, UNAVAILABLE, DISCONNECTED.
- actions: normalized cards, sorted by shared urgency → source impact band → confidence → stable ID.
- attentionCount: actionable cards **in this page**, not the unseen account total.
- assessments: per-league coverage and result status.
- discoveredCount, assessedCount (this page), pageOffset, nextCursor, complete.
- discoveryCoverage: AVAILABLE_VARIANTS or PARTIAL; not proof ESPN exposes every league.
- paginationState: RESTART_REQUIRED for invalid/stale/cross-account cursors; client discards pages/restarts.
  Early connection failures have no page data. Clients tolerate absent pagination/count fields.

Each action includes id, schemaVersion, provider/sport/season/league/team scope, leagueName, type, headline,
summary, subjects when known, source evidence, urgency/impact/confidence, actionable, generatedAt,
freshness(observedAt, optional valuesAt, expiresAt), destination(tool,scope), and apply.capability=READ_ONLY.
Engine-derived cards include recommendation.source=lineupAdvisor and the existing display move. No
executable plan is exposed. Source gain is retained with its source, never compared numerically across
sports. Urgency stays UNKNOWN without a validated deadline. Injury cards fixed by an engine swap are
merged into that remedy; matching vacancy cards are suppressed when the engine already proposes a fill.
Cards with multiple independent remedies remain separate. Scope-qualified stable IDs deduplicate pages.

Supported adapters: STARTER_UNAVAILABLE, EMPTY_SLOT, LINEUP_UPGRADE, IL_IR_ACTION (existing to/from reserve),
WAIVER_OPPORTUNITY (only with candidate data). Unhandled drop/reserve-capacity/deferred warnings make
assessment PARTIAL, not fake All Clear. No independent add/drop or transaction behavior. Existing lineup
writes and Autopilot remain available only through their separately gated tools.

Assessments include scope, leagueName, observedAt, checkedSignals, unsupportedSignals, unsupportedFields,
capabilities, recommendationSupport/recommendationReason when assessed, status, summary and clearScope.
Status includes EMPTY_ROSTER, ACTIONS, ALL_CLEAR, PARTIAL, STALE, UNAVAILABLE, UNSUPPORTED. Normal pre-draft
empty entries yield EMPTY_ROSTER and no vacancy alarm; missing entries remain unavailable.
READ_ONLY means provider inspection only; RECOMMENDATIONS means this source passed coverage/freshness
gates, not support for every imaginable action. Unsupported NHL slot/reserve/category-label fields stay
explicit. Team display abbreviations and unobserved provider behavior are not guessed.

ALL_CLEAR applies ONLY to checkedSignals. With a valid engine snapshot it means no meaningful action was
found in those checks; trading, lock urgency and anything in unsupportedSignals remain unassessed. Without
an engine snapshot, the availability-only scope remains explicit. Missing/stale recommendation data yields
PARTIAL. Waiver checks concern the bounded candidate pool. Roster observations >5m suppress action cards.

## Pagination/security contract

My Edge requests both existing ESPN fan variants and unions/deduplicates their results, rather than
stopping after the first successful response. Default discovery behavior for other callers is unchanged.
Each page re-discovers, sorts the scope list, and reads at most4 rosters concurrently. Scope changes,
account changes or reconnect generation changes invalidate the cursor. Its fingerprint includes authenticated
userId, connection generation (legacy owner fallback) and discovered scopes. The cursor conveys no access
rights; every page derives identifiers from provider discovery and revalidates ownership. No client-provided
league IDs are used. Cursor length/offset bounds are checked. Failed roster reads remain per-league errors.

This is pagination over ESPN's available discovered list, not an undocumented provider pagination protocol.
A partial fan response is flagged; manual MLB references are now unioned with fan discovery. Providers omitted by both paths remain
unavailable. Manual references are resolved to the current owner team before any assessment is shown. Re-discovery costs up to2 fan GETs/page; up to4 roster reads and, for eligible leagues,
up to4 optional free-agent reads plus cached dataset/bye reads. Per-call provider timeouts remain; no claim
of an8-second whole-request deadline. No shared cache or stale cursor can bypass ownership.

## Initial UI shell

`fantasyedge-my-edge.html`, assets/my-edge.js and assets/my-edge.css. Entry link in Team Manager sidebar.
Uses existing FE auth/apiPost helpers. Requires existing Premium; signed-out/upgrade/connect/error states
are explicit. Load More retrieves the next page; Refresh clears the accumulated view. Identity changes
clear private cards and discard old responses. Client deduplicates by action/scope and uses the same
myEdgePriority comparator as the server; attention count reflects accumulated fresh cards only. Expired
cards are removed during rendering and a30-second interval. Preseason/partial/unsupported league coverage
remains visible. No writes, automation switches or fake sample data. All provider text uses textContent.

Links are allowlisted existing Team Manager, Trade Center and Coach pages. Why shows deterministic source
evidence inline. Tool links preserve validated platform/sport/season/leagueId/teamId query parameters through shared
leagueNavigation.js. These are navigation intent, never ownership proof. Targeted leagues and leagueContext
reads revalidate the authenticated ESPN owner. Invalid/duplicate/incomplete query fields fail closed in the
browser. Team Manager permits targeted NBA/NHL read-only views while general off-season tabs remain gated.
Unknown NHL slots render “Unverified slot”, not Bench. Coach receives a fresh verified roster summary and
prepares an editable question; nothing is automatically sent to an LLM. Trade Center selects the verified
league, without automatically scanning or adding a trade recommendation adapter.

## Manual and selected league coverage

The current supported manual-add path is MLB only. Current/upcoming manual season references join the
same bounded four-reference pagination as discovery, deduplicated by sport/season/league. Ownership is
derived on each manual read; unavailable or no-longer-owned references produce no stored roster/name cards.
Prior-calendar-year MLB references remain stored for history but are excluded from daily My Edge advice.
Missing credentials return DISCONNECTED before discovery or manual reads. Reconnection never grants old
references ownership or automation permission. There is no global selected-league preference in this phase;
per-tool selection/localStorage is navigation, not an account-wide My Edge filter.

Assessments add connectionSource: discovered/manual. Responses add manualCoverage: LOADED/UNAVAILABLE,
excludedManualCount (failed references on this page), archivedManualCount (prior-season references).
discoveredCount is retained for compatibility but counts combined candidate references; assessedCount counts
actual assessments. The UI calls these league references and retains partial warnings across pages. A full
page traversal does not assert exhaustive ESPN coverage. No new manual NBA/NHL path is implied.

## Browser verification

npm run check:my-edge-browser uses real Chromium against a local HTTP server and the actual My Edge
aggregator with controlled authentication/provider dependencies and sanitized historical/preseason fixtures.
Production HTML/modules are served; test-only auth and tool context endpoints isolate this from live users.
Desktop1440px and mobile390px pass: layout, sidebar, Premium/signed-out/free gates, loading, empty, scoped
All Clear, multiple leagues, NBA preseason, NHL partial coverage, pagination, stale labels, order/dedup,
unsafe display checks, targeted Team Manager/Trade Center/Coach, invalid/unowned targets and read-only calls.
Server ownership is independently exercised in check:espn-handler. This is NOT live Clerk/Vercel/Redis/ESPN
end-to-end certification. No live account calls or transactions were made. Screenshots remain in /tmp.

Install Playwright/Chromium in external test tooling; the repository dependencies are unchanged. Set
FE_PLAYWRIGHT_MODULE to its absolute index.mjs and PLAYWRIGHT_BROWSERS_PATH to the downloaded browser
location before running the browser command. This optional browser suite is separate from offline checks.

Tests: npm run check:my-edge includes foundation, shared parity/adapters/pagination, and DOM-contract UI
suites. Existing ESPN/handler/Autopilot/LeagueConfig/DNA/credentials/readiness and88 Coach checks also pass.
Next: review this browser/navigation milestone, then stronger provider scoring/slot evidence before
expanding NBA/NHL recommendation capabilities. See my-edge-home-integration.md for the homepage proposal. No production rollout implied.
