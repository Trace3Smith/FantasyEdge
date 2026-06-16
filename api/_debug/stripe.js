// ⚠️ TEMPORARY DIAGNOSTIC — DELETE AFTER USE. Inspects the *deployed* Stripe env
// values (the exact strings Vercel injects) and live-tests them, without leaking
// the secret. Returns key shape + whitespace flags, a live Stripe ping with both
// the raw and trimmed key (to catch trailing-newline corruption), and whether the
// configured price ids resolve. No full secret is ever returned.
import Stripe from 'stripe';

async function ping(key) {
  if (!key) return 'no key';
  try {
    const s = new Stripe(key);
    const r = await s.prices.list({ limit: 1 });
    return `ok (${r.data.length} price[s] visible)`;
  } catch (err) {
    return `${err.type || err.name || 'Error'}: ${err.message}`;
  }
}

async function resolvePrice(key, id) {
  if (!key || !id) return id ? 'no key' : 'NOT SET';
  try {
    const s = new Stripe(key.trim());
    const p = await s.prices.retrieve(id);
    const amt = p.unit_amount != null ? `$${(p.unit_amount / 100).toFixed(2)}` : '?';
    const iv = p.recurring?.interval ? `/${p.recurring.interval}` : ' (one-time)';
    return `${p.id} ${amt} ${p.currency}${iv} active=${p.active}`;
  } catch (err) {
    return `${err.type || 'Error'}: ${err.message}`;
  }
}

export default async function handler(req, res) {
  const raw = process.env.STRIPE_SECRET_KEY || '';
  const trimmed = raw.trim();
  const monthly = process.env.STRIPE_PRICE_MONTHLY || '';
  const annual = process.env.STRIPE_PRICE_ANNUAL || '';

  const [pingRaw, pingTrimmed, monthlyInfo, annualInfo] = await Promise.all([
    ping(raw),
    ping(trimmed),
    resolvePrice(trimmed, monthly),
    resolvePrice(trimmed, annual),
  ]);

  return res.json({
    note: 'TEMPORARY diagnostic — delete after use. No secret is returned.',
    key: {
      present: !!raw,
      prefix: raw.slice(0, 8),               // sk_test_ / sk_live_
      rawLen: raw.length,
      trimmedLen: trimmed.length,
      hasSurroundingWhitespace: raw !== trimmed,   // ← trailing newline/space?
      last4: trimmed.slice(-4),
    },
    stripePing: {
      withRawKey: pingRaw,                    // fails but withTrimmedKey ok => whitespace is the bug
      withTrimmedKey: pingTrimmed,
    },
    prices: {
      STRIPE_PRICE_MONTHLY_value: monthly || 'NOT SET',
      STRIPE_PRICE_MONTHLY_resolves: monthlyInfo,
      STRIPE_PRICE_ANNUAL_value: annual || 'NOT SET',
      STRIPE_PRICE_ANNUAL_resolves: annualInfo,
    },
    appUrl: process.env.APP_URL || '(unset — using fallback)',
  });
}
