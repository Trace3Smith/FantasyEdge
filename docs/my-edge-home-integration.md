# My Edge signed-in entry plan

Proposal only; no homepage redirects, pricing changes or navigation redesign in this milestone.

## Current entry and account states

My Edge is a standalone Advisor page linked from the Team Manager sidebar. It routes into existing
Team Manager, Trade Center and Coach surfaces with validated league scope. Public acquisition pages
and their deep links remain intact. My Edge uses the existing Premium gate, not a new entitlement.

| Visitor | Recommended experience |
| --- | --- |
| Signed out | Keep public rankings, draft tools, Pick'em and brackets accessible. A My Edge entry explains connected league advice and offers sign-in; show no private league data. |
| Signed-in free | Keep useful public tools. Explain My Edge's Premium benefit and show clearly labeled feature examples, never fabricated personal action counts. Current API continues to require Premium. |
| Premium, disconnected | Offer the existing ESPN connection flow and manual cookie fallback. Explain that no leagues are currently checked. |
| Premium, connected | Open actual league assessments, scoped All Clear, partial coverage and fresh actions. Preserve explicit unavailable/preseason states. |

## Navigation and eventual default landing

Add a consistent My Edge entry to signed-in tool navigation as a separate small follow-up. Preserve the
current Team Manager sidebar entry. Keep existing tool names and deep links; My Edge is an overview, not
a replacement editor. The mobile menu should expose the same destination without adding a second menu.

Eventually the signed-in root visit can offer “Make My Edge my home”, after production authentication,
credential rollout and connected-league coverage have been verified. Do not redirect inbound public tool
URLs. Start with an explicit preference rather than forcing an empty connected experience on new accounts.
That preference and a global selected-league picker do not exist yet and require a separate implementation.

## Visible but locked opportunities

Describe Premium connected roster review and existing supported recommendations to free users. Label
examples as examples; no “three urgent actions” without authorized fresh evidence. Keep sport limitations
visible before purchase: NBA category optimization is not validated, NHL slot/reserve/category labels remain
partial, and neither sport has enabled writes/Autopilot. Do not imply Premium unlocks unsupported behavior.

## League coverage and rollout prerequisites

My Edge now includes available discovered scopes plus current/upcoming supported manual MLB references.
Each reference is checked against the connected account. Archived references are retained but excluded
from daily advice; unreadable/unowned references produce a coverage warning, not stale roster cards.
Disconnect blocks all reads before stored references are used. Tool selection is not an account-wide filter.
A future selected-league preference must be sport/provider/season qualified, ownership checked and must
distinguish intentional user exclusion from a provider failure.

Before making My Edge the default, complete the separately documented encryption production rollout,
verify live Clerk/ESPN reads with an authorized account, review bounded multi-page latency, and confirm
partial/no-league onboarding works for real accounts. Continue acquiring provider evidence before adding
NBA category recommendations or NHL slot-based advice. No urgency, coverage or automation claims should
be expanded simply to fill the homepage.
