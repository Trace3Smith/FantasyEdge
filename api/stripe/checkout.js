// Creates a Stripe Checkout Session for a Premium subscription. The caller picks the
// billing interval ('month' = $9.99/mo, 'year' = $79/yr); we map it to the matching
// Stripe price, ensure the user has a Stripe customer, and hand back a hosted
// Checkout URL. The webhook (not this endpoint) is what flips the user to premium.
import { stripe, clerkClient, PRICE_BY_INTERVAL, APP_URL } from '../_lib/billing.js';
import { requireUser, sendError, HttpError } from '../_lib/auth.js';

// Find the user's existing Stripe customer (cached in Clerk metadata) or create one,
// tagging it with the Clerk userId so the webhook can map subscription -> user.
async function getOrCreateCustomer(userId) {
  const user = await clerkClient.users.getUser(userId);
  const existing = user.publicMetadata?.stripeCustomerId;
  if (existing) return existing;

  const email = user.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress;
  const customer = await stripe.customers.create({
    email,
    metadata: { clerkUserId: userId },
  });

  // Mirror the id onto the Clerk user so we reuse the same customer next time.
  await clerkClient.users.updateUserMetadata(userId, {
    publicMetadata: { ...user.publicMetadata, stripeCustomerId: customer.id },
  });
  return customer.id;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ⚠️⚠️ TEMPORARY AUTH BYPASS — FOR TESTING ONLY, REVERT BEFORE GO-LIVE ⚠️⚠️
    // Purpose: isolate Stripe from Clerk. While bypassed, the endpoint creates a
    // Checkout session WITHOUT requiring a valid Clerk token. If a valid token is
    // present we still tag the customer/userId; if not, Stripe collects the email
    // at checkout. NOTE: with no userId, the webhook can't map the subscription
    // back to a Clerk user, so completing payment under bypass will NOT flip the
    // plan to premium. To restore security, replace this block with:
    //     const { userId } = await requireUser(req);
    //     ... const customer = await getOrCreateCustomer(userId);
    //     ... client_reference_id: userId, customer,
    let userId = null;
    try { ({ userId } = await requireUser(req)); } catch { /* bypassed for testing */ }
    console.warn('[checkout] AUTH BYPASS ACTIVE — userId:', userId);

    const interval = (req.body?.interval || 'month').toLowerCase();
    const price = PRICE_BY_INTERVAL[interval];
    if (!price) throw new HttpError(400, `Unknown billing interval: ${interval}`);

    const customer = userId ? await getOrCreateCustomer(userId) : undefined;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      ...(customer ? { customer } : {}),
      ...(userId ? { client_reference_id: userId } : {}),
      line_items: [{ price, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${APP_URL}/fantasyedge-draft.html?upgraded=1`,
      cancel_url: `${APP_URL}/fantasyedge-rankings.html?checkout=cancelled`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    return sendError(res, err);
  }
}
