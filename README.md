# FantasyEdge

Multi-sport fantasy analytics — plain HTML pages + Vercel serverless functions +
Upstash Redis. Live at https://fantasy-edge-nine.vercel.app.

## Premium (Clerk auth + Stripe paywall)

Free users see rankings as-is and get **1 mock draft per day** (basic settings,
draft-assistant advice for rounds 1–7). **Premium ($5/mo or $50/yr)** unlocks
unlimited mock drafts, full-draft advice, real draft mode, and (Phase 2) custom
league settings.

- **Auth:** Clerk (vanilla JS, loaded via CDN in `auth.js` — shared by every page).
- **Payments:** Stripe Checkout + Billing Portal. The Stripe webhook is the only
  writer of subscription state; it mirrors the plan into Clerk
  `user.publicMetadata.plan` (`'premium'`), which the frontend reads for UI gating.
- **Trust boundary:** every gated API endpoint re-verifies the Clerk session token
  server-side (`api/_lib/auth.js`) and re-checks plan + the daily mock quota
  (Upstash Redis). Frontend gating is cosmetic.

### Required environment variables (Vercel project settings)

| Var | Source | Notes |
| --- | --- | --- |
| `CLERK_PUBLISHABLE_KEY` | Clerk dashboard | Public; served to the browser via `/api/public-config`. |
| `CLERK_SECRET_KEY` | Clerk dashboard | Server only. |
| `CLERK_JWT_KEY` | Clerk → API Keys → JWT public key (PEM) | Enables networkless token verification. |
| `STRIPE_SECRET_KEY` | Stripe dashboard | Server only. |
| `STRIPE_PRICE_MONTHLY` | Stripe → recurring price | $5/month price id (`price_…`). |
| `STRIPE_PRICE_ANNUAL` | Stripe → recurring price | $50/year price id (`price_…`). |
| `STRIPE_WEBHOOK_SECRET` | Stripe → webhook endpoint | Signing secret (`whsec_…`). |
| `APP_URL` | — | Base URL for Stripe redirects, e.g. `https://fantasy-edge-nine.vercel.app`. |
| `ANTHROPIC_API_KEY` | (already set in prod) | Reused by `api/draft/advise.js` for pick rationales. |

Upstash Redis vars (`KV_REST_API_URL`/`KV_REST_API_TOKEN` or `UPSTASH_*`) are
already provisioned for the rankings cache.

### Stripe setup

1. Create one **Product** with two recurring **Prices**: $5/month and $50/year.
   Put their ids in `STRIPE_PRICE_MONTHLY` / `STRIPE_PRICE_ANNUAL`.
2. Add a **webhook endpoint** at `/api/stripe/webhook` subscribed to:
   `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`. Copy its signing secret to
   `STRIPE_WEBHOOK_SECRET`.

### Local development

```bash
npm install
vercel dev                                   # serves static pages + /api functions
stripe listen --forward-to localhost:3000/api/stripe/webhook   # use the printed whsec_… locally
```

Use a Clerk **development** instance and Stripe **test mode**. Test card:
`4242 4242 4242 4242`, any future expiry/CVC.

## API surface (premium)

- `GET  /api/public-config` — public Clerk key for the frontend bootstrap.
- `POST /api/stripe/checkout` — `{ interval: 'month' | 'year' }` → Checkout URL.
- `POST /api/stripe/portal` — Billing Portal URL (manage/cancel).
- `POST /api/stripe/webhook` — Stripe → Clerk plan mirror (raw body).
- `POST /api/draft/mock-start` — start a mock (free: 1/day, basic settings).
- `POST /api/draft/advise` — best-available candidates + Claude rationale
  (free: rounds 1–7).
