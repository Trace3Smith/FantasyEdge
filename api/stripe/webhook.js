// Stripe webhook — the single source that flips a user's plan in Clerk. Stripe is
// the source of truth for subscription state; Clerk publicMetadata.plan is just a
// mirror the frontend can read. Signature verification needs the raw request body,
// so Vercel's automatic JSON body parsing is disabled below.
import { stripe, clerkClient } from '../_lib/billing.js';

export const config = { api: { bodyParser: false } };

// Buffer the raw request stream for Stripe signature verification.
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Merge plan fields into the user's Clerk publicMetadata without clobbering other
// keys (e.g. stripeCustomerId set during checkout).
async function setPlan(userId, fields) {
  if (!userId) return;
  const user = await clerkClient.users.getUser(userId);
  await clerkClient.users.updateUserMetadata(userId, {
    publicMetadata: { ...user.publicMetadata, ...fields },
  });
}

// A subscription is only premium while Stripe reports it active or trialing.
const ACTIVE = new Set(['active', 'trialing']);

// Resolve the Clerk userId for a subscription event via the customer's stored tag.
async function userIdForCustomer(customerId) {
  if (!customerId) return null;
  const customer = await stripe.customers.retrieve(customerId);
  return customer?.metadata?.clerkUserId || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let event;
  try {
    const raw = await readRawBody(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Webhook signature failed: ${err.message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        const sub = s.subscription ? await stripe.subscriptions.retrieve(s.subscription) : null;
        await setPlan(s.client_reference_id, {
          plan: 'premium',
          stripeCustomerId: s.customer,
          subscriptionStatus: sub?.status || 'active',
          currentPeriodEnd: sub?.current_period_end ?? null,
        });
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const userId = await userIdForCustomer(sub.customer);
        await setPlan(userId, {
          plan: ACTIVE.has(sub.status) ? 'premium' : 'free',
          subscriptionStatus: sub.status,
          currentPeriodEnd: sub.current_period_end ?? null,
        });
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const userId = await userIdForCustomer(sub.customer);
        await setPlan(userId, { plan: 'free', subscriptionStatus: 'canceled' });
        break;
      }
      default:
        break; // ignore unrelated events
    }
    return res.json({ received: true });
  } catch (err) {
    // Return 500 so Stripe retries transient Clerk failures.
    return res.status(500).json({ error: err.message });
  }
}
