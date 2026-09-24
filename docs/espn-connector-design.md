# FantasyEdge ESPN Connector: design, not implementation

2026-09-12. No extension, linking endpoint or new provider integration was built in this task.
Prerequisite: [credential security rollout](espn-credential-security.md). Never make cookie acquisition
easier before the server can protect, expire and revoke those credentials.

## User flow and success metric

Homepage → sign in/create Clerk account → Connect ESPN → install/open the official FantasyEdge
Connector → normal ESPN sign-in if needed → click Connect My ESPN Account → discovered leagues →
select leagues and confirm masked account → My Edge assessment. Keep the existing manual espn_s2/SWID
entry as an explicitly labeled fallback. The extension never asks for an ESPN password or imitates login.

Target under 60 seconds from homepage to useful personalized output for an already signed-in ESPN user.
Measure elapsed time and completion per stage, separating cold install/login from returning connection.
Store no cookie/member-ID telemetry. Extension installation, store approval, mobile browser support and
new ESPN login can exceed 60 seconds; this is a product target, not a current guarantee. Show read-only
connection health promptly while selected league analysis completes. A user should not have to type
league IDs unless fan discovery misses a league. The existing MLB manual fallback stays available.

## Proposed protocol: authenticated start, restricted exchange, confirmed finalization

Use future action cases in the existing multiplexed API, not additional Vercel handlers. The server's
provider adapter owns all ESPN calls. The normal website and its analytics never see cookie values.

1. User explicitly opens the extension popup. Generate an ephemeral random verifier in extension memory
   and derive a SHA-256 challenge. Contact only a trusted FantasyEdge page using the browser's external
   messaging channel. Check sender URL/origin exactly against the production allowlist; never substring
   match a URL. No content script should read ESPN DOM or inject code into ESPN login.
2. The signed-in FantasyEdge page sends `connectStart` with its Clerk Bearer token and challenge. Server
   verifies the current user, exact web origin and intended provider, then creates a cryptographically
   random grant. Redis stores only a hash of it plus userId, challenge, provider, issuedAt, expiresAt and
   state `pending`, with a proposed 2-minute TTL. Rate-limit start per authenticated user and IP. Caller
   cannot choose another Clerk user ID. Connection does not grant Premium, automation or DNA consent.
3. Website returns the short-lived grant through the restricted extension channel. Popup displays the
   destination account context and asks the user to connect. Extension obtains only the two named ESPN
   cookies on this explicit gesture. Missing cookies leads to the real ESPN login page and retry.
4. Extension sends grant + verifier + cookies directly to the FantasyEdge HTTPS exchange endpoint from
   its service worker. No cookie in URL, fragment, clipboard, DOM, website message or logs. Server checks
   hash, TTL, challenge, allowed extension origin and state. Consume the grant atomically (Lua) BEFORE
   provider validation; concurrent/replayed requests fail. Origin/CORS are defense in depth, not identity;
   the grant and verifier are the authority. Return only bounded, non-sensitive outcome codes.
5. Server normalizes cookie inputs and validates against ESPN, discovers leagues, and stages an encrypted
   pending connection (proposed 2-minute TTL), associated with the original Clerk user. Do not replace an
   existing account on exchange alone. A failed validation requires a new grant, not replaying the old one.
6. The authenticated website polls an opaque status ID scoped to the same Clerk user and sees masked
   account identity + discovered league names/sports. The league-selection confirmation finalizes the
   link atomically: selected IDs must be a subset of server-discovered and ownership-verified teams.
   Save through the hardened credential lifecycle, create a new connection generation, revoke old
   automation, invalidate personal caches and remove the pending record. Existing DNA choice is handled
   through the current-version notice independently; do not pre-authorize automation on the selection form.
7. The extension discards cookies/verifier/grant immediately after completion or failure. No persistent
   browser-cookie mirror, background monitoring or automatic reconnect. Expired state or worker restart
   restarts the flow; prior permissions never silently reactivate.

The challenge/verifier binding limits use of a stolen grant; user confirmation limits account-linking
substitution. A compromised official extension can still steal cookies it is permitted to read. Minimize
its code/dependencies, use packaged code/CSP, review releases and never load remote executable scripts.
The existing app has no linking-state implementation: this protocol needs a dedicated threat-model and
regression review before implementation, especially multi-tab replay and disconnect/finalize races.

For exchange CORS, allow only published extension IDs and explicitly supported environments; no wildcard
credentials origin. Handle OPTIONS only for those future exchange actions. Keep Clerk-based website
requests and grant-only exchange separate; do not relax the existing dispatcher globally. Bind finalization
to an authenticated POST and anti-CSRF state even if session cookies are later introduced. Bearer tokens
are not to be handed to the extension. Set no-store on personal/status/exchange responses. Request-body,
error, tracing and analytics capture must redact the cookie fields before any logging integration.

## Minimum Chrome/Chromium permissions (Manifest V3 proposal)

| Permission / setting | Purpose and limit |
|---|---|
| `cookies` | Read only espn_s2 and SWID using named get calls, never enumerate all cookies. The API itself is broader, so code and review enforce the narrow use. |
| ESPN host permission | Start with `https://fantasy.espn.com/*`; verify actual cookie domain/path/store behavior. Add an exact ESPN root/www host only if testing proves required; do not request all websites. |
| FantasyEdge HTTPS host permission | Direct service-worker exchange POST to the canonical production host; no arbitrary user-supplied URL or proxy. |
| `externally_connectable.matches` | Only exact FantasyEdge production website origins; no wildcard subdomain trust. Restrict sender checks too. |
| Extension action/popup | Explicit connect gesture and status; this is UI configuration, not permission to read tabs. |

No browser history, tabs-reading, activeTab, scripting, webRequest, all_urls, unrelated site access,
password access or sync storage. Do not request storage initially: transient memory only and restart the
flow if a service worker expires. If worker reliability later requires `storage.session`, justify it
separately and store only short-lived linking metadata, never cookies. Host permissions may be requested
at connection time for clearer consent. Review exact cookie access with domain cookies and partitioned
stores before claiming the single-host minimum works in all browsers.

Chrome documents that cookie access requires both the cookies permission and matching host permissions;
external website messaging is constrained through externally_connectable; service-worker cross-origin
requests require host access. These are platform facts, not evidence that an ESPN cookie capture prototype
has been validated. See [cookies](https://developer.chrome.com/docs/extensions/reference/api/cookies),
[external messaging](https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable)
and [network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests).
Browser-store acceptance and ESPN's approval of this integration are **Unknown from repository**.

## Automatic discovery and provider abstraction

Existing `fetchFanLeagues` parses ESPN fan preferences across FLB/FFL/FBA/FHL/WFBA and keeps league,
team, season and sport. Reuse this once after validation, verify ownership against league responses and
show all supported sports with their current capability limitations. Preserve no-leagues, expired,
fan-error and truncated states. Do not interpret a successful empty fan response as proof of a healthy
account with zero leagues; existing code already treats it as potentially expired. Revalidate manual
fallback references. Separate discovering a league from the user selecting it for personal monitoring.
Do not copy selected-league choices into the independently consented League DNA sweep scope.

Proposed adapter interface (functions optional, explicit capability advertisement):

```js
{
  platform,
  connectionMethods, // ESPN connector/manual; Yahoo OAuth; Sleeper public discovery
  capabilities(scope, settings),
  connect, disconnect, discoverLeagues,
  getLeague, getRoster, getScoring, getLineup,
  getTransactions, // optional; do not imply live draft support
  applySupportedAction // optional; no generic arbitrary provider POST
}
```

Every method accepts a server-owned connection reference, not browser cookies or a caller-selected user.
Return normalized identity plus raw provider evidence where needed, an observation timestamp, coverage
and typed errors (auth-expired, permission-denied, unsupported, rate-limited, temporary-failure).
Separate provider season identifiers from current calendar year. Shared valuation modules consume normalized
settings/rosters; provider adapters never become competing valuation engines. Capability evaluation is
provider + sport + league format + action + validation state, intersected with entitlement and explicit
user permission. Separate discovery, read, recommendations, dry-run, manual apply and automation.

Yahoo should use official OAuth authorization and encrypted refresh-token lifecycle with least required
scopes. It must not inherit the ESPN cookie strategy. Yahoo's current official documentation specifies
OAuth 2.0 for Fantasy API access: [Yahoo Fantasy API](https://sports.yahoo.com/developer/docs/).
App registration/scopes and approved deployment credentials are **Unknown from repository**.

Sleeper's documented public API provides user/account/league discovery; initially use verified read
operations and advertise read-only. Do not infer a supported write API, OAuth flow or five-sport coverage.
See the official [Sleeper API](https://docs.sleeper.com/) for available endpoints. Provider expansion must
verify sport coverage and rate limits when implemented. Neither provider is implemented during this task.

## Acceptance tests before building/shipping connector

Expired, reused and concurrent grants; wrong user/extension/origin; invalid challenge; two simultaneous
browser sessions; malicious sender URL; arbitrary redirect/endpoint; finalization after disconnect;
account switch; ESPN rejection and guest response; missing cookies; multi-league/season/sport collisions;
provider timeout; storage outage; no secret values in logs/network URLs/website messages; no permission
outside named hosts; no automatic Autopilot or DNA enrollment. Finalization must preserve current manual
fallback and encryption/backward-compatibility behavior. No real lineup write is part of connector testing.
