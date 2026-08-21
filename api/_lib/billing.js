// Shared singletons for the auth/payments stack: the Stripe client and the Clerk
// backend client. Both are created once per warm serverless instance. Env vars are
// injected by Vercel (Stripe + Clerk dashboards); see README for the full list.
import Stripe from 'stripe';
import { createClerkClient } from '@clerk/backend';

// .trim() guards against trailing whitespace/newlines in pasted env values — a
// trailing newline in an API key corrupts the Authorization header (Stripe surfaces
// it as a StripeConnectionError; Clerk JWKS fetches fail as "invalid session").
//
// Lazily constructed: `new Stripe('')` throws at construction when the key is
// absent, which would crash EVERY module that imports this file at import time —
// including api/sports.js (via auth.js), which never uses Stripe. Deferring
// construction to first actual use keeps those unrelated modules importable when
// STRIPE_SECRET_KEY isn't present (e.g. Preview deploys), while payment endpoints
// still get a real client (and still surface a clear error if the key is missing
// when they actually call Stripe). Behaviour in production is unchanged.
let _stripe = null;
function getStripe() {
  if (!_stripe) _stripe = new Stripe((process.env.STRIPE_SECRET_KEY || '').trim());
  return _stripe;
}
// A Proxy preserves the existing `import { stripe }` + `stripe.checkout.sessions
// .create(...)` usage exactly; only the first property access triggers construction.
export const stripe = new Proxy({}, {
  get(_target, prop) {
    const client = getStripe();
    const value = client[prop];
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

export const clerkClient = createClerkClient({
  secretKey: (process.env.CLERK_SECRET_KEY || '').trim(),
});

// The two recurring prices created in the Stripe dashboard. The checkout endpoint
// maps the requested billing interval to one of these; anything else is rejected.
export const PRICE_BY_INTERVAL = {
  month: process.env.STRIPE_PRICE_MONTHLY,
  year: process.env.STRIPE_PRICE_ANNUAL,
};

// Absolute base URL for Stripe success/cancel + portal return redirects. Falls back
// to the canonical prod domain so a missing env var degrades gracefully rather than 500ing.
export const APP_URL = process.env.APP_URL || 'https://www.fantasyedgeapp.com';
