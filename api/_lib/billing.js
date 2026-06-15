// Shared singletons for the auth/payments stack: the Stripe client and the Clerk
// backend client. Both are created once per warm serverless instance. Env vars are
// injected by Vercel (Stripe + Clerk dashboards); see README for the full list.
import Stripe from 'stripe';
import { createClerkClient } from '@clerk/backend';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

// The two recurring prices created in the Stripe dashboard. The checkout endpoint
// maps the requested billing interval to one of these; anything else is rejected.
export const PRICE_BY_INTERVAL = {
  month: process.env.STRIPE_PRICE_MONTHLY,
  year: process.env.STRIPE_PRICE_ANNUAL,
};

// Absolute base URL for Stripe success/cancel + portal return redirects. Falls back
// to the known prod host so a missing env var degrades gracefully rather than 500ing.
export const APP_URL = process.env.APP_URL || 'https://fantasy-edge-nine.vercel.app';
