// Manually grant/revoke premium for a user without going through Stripe — for testing.
// Premium is gated purely on Clerk publicMetadata.plan === 'premium' (see
// api/_lib/auth.js isPremiumUser); this sets that field, the same way the Stripe webhook
// does (api/stripe/webhook.js setPlan), merging so stripeCustomerId etc. aren't clobbered.
//
// Usage (CLERK_SECRET_KEY must be the instance you want to edit — use the sk_live_ key
// for production):
//   CLERK_SECRET_KEY=sk_live_xxx node scripts/grant-premium.js <userId|email> [premium|free]
//
// Examples:
//   node scripts/grant-premium.js user_2abc... premium
//   node scripts/grant-premium.js tester@example.com          # defaults to premium
//   node scripts/grant-premium.js tester@example.com free     # revoke
import { createClerkClient } from '@clerk/backend';

const secretKey = (process.env.CLERK_SECRET_KEY || '').trim();
if (!secretKey) {
  console.error('CLERK_SECRET_KEY is not set. Pass the sk_live_ (or sk_test_) key for the instance you want to edit.');
  process.exit(1);
}

const [identifier, planArg = 'premium'] = process.argv.slice(2);
if (!identifier) {
  console.error('Usage: node scripts/grant-premium.js <userId|email> [premium|free]');
  process.exit(1);
}
if (planArg !== 'premium' && planArg !== 'free') {
  console.error(`Invalid plan "${planArg}". Use "premium" or "free".`);
  process.exit(1);
}

const clerk = createClerkClient({ secretKey });

// Accept either a Clerk user id (user_...) or an email; resolve the email to a user.
async function resolveUser(id) {
  if (!id.includes('@')) return clerk.users.getUser(id);
  const { data } = await clerk.users.getUserList({ emailAddress: [id] });
  if (!data.length) throw new Error(`No user found with email ${id}`);
  if (data.length > 1) throw new Error(`Multiple users match ${id}; pass the user_… id instead.`);
  return data[0];
}

try {
  const user = await resolveUser(identifier);
  const before = user.publicMetadata?.plan ?? '(unset)';
  // Merge, mirroring the webhook so we don't drop stripeCustomerId or other keys.
  await clerk.users.updateUserMetadata(user.id, {
    publicMetadata: { ...user.publicMetadata, plan: planArg },
  });
  const email = user.emailAddresses?.[0]?.emailAddress || '(no email)';
  console.log(`✓ ${email} (${user.id}): plan ${before} → ${planArg}`);
} catch (err) {
  console.error('Failed:', err.message || err);
  process.exit(1);
}
