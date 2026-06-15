// Opens the Stripe Billing Portal so a subscriber can update their card, view
// invoices, or cancel. Requires an existing Stripe customer (set during checkout).
import { stripe, clerkClient, APP_URL } from '../_lib/billing.js';
import { requireUser, sendError, HttpError } from '../_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId } = await requireUser(req);
    const user = await clerkClient.users.getUser(userId);
    const customer = user.publicMetadata?.stripeCustomerId;
    if (!customer) throw new HttpError(400, 'No billing account yet');

    const session = await stripe.billingPortal.sessions.create({
      customer,
      return_url: `${APP_URL}/fantasyedge-rankings.html`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    return sendError(res, err);
  }
}
