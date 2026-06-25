// Server-side auth + entitlement gating. The frontend's show/hide is cosmetic; this
// is the real trust boundary. Every gated endpoint verifies the Clerk session token
// here and re-checks plan/quota — never trusting client-supplied state.
import { verifyToken } from '@clerk/backend';
import { clerkClient, APP_URL } from './billing.js';
import { redis } from './kv.js';

// Free users get this many mock drafts per UTC day; premium is unlimited.
export const FREE_DAILY_MOCKS = 1;
// Free users get assistant suggestions through this round; later rounds upsell.
export const FREE_MAX_ROUND = 7;
const QUOTA_TTL_SECONDS = 36 * 60 * 60; // > 24h so a key never expires mid-day

// A thrown HttpError carries the status the endpoint should return. Endpoints wrap
// their gating in try/catch and forward err.status (defaulting to 500).
export class HttpError extends Error {
  constructor(status, message, payload) {
    super(message);
    this.status = status;
    this.payload = payload || { error: message };
  }
}

// Origins Clerk's token must have been minted for. Networkless verification rejects
// tokens whose `azp` isn't in this list, blocking token reuse from other apps. The
// production app is served from the custom domain (apex + www), so the token's azp is
// one of those — they must be listed here or every prod token 401s as
// token-invalid-authorized-parties. The APP_URL origin (the vercel.app host) is kept
// for preview/deploy URLs.
function authorizedParties() {
  const parties = [
    'http://localhost:3000',
    'https://localhost:3000',
    'https://www.fantasyedgeapp.com',
    'https://fantasyedgeapp.com',
  ];
  try {
    parties.push(new URL(APP_URL).origin);
  } catch {}
  return parties;
}

// Verify the Bearer token and return the Clerk userId + raw claims, or throw 401.
// Uses networkless verification when CLERK_JWT_KEY (the instance PEM) is set; falls
// back to JWKS-over-network via the secret key otherwise.
export async function requireUser(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) throw new HttpError(401, 'Not signed in');

  try {
    const claims = await verifyToken(token, {
      // jwtKey (the PEM public key) makes verification networkless — no per-request
      // JWKS fetch, which is what was intermittently failing (jwk-failed-to-resolve).
      // Normalize both paste styles: trim surrounding whitespace AND convert literal
      // "\n" escapes into real newlines, so a single-line or multi-line PEM both work.
      jwtKey: (process.env.CLERK_JWT_KEY || '').trim().replace(/\\n/g, '\n') || undefined,
      secretKey: (process.env.CLERK_SECRET_KEY || '').trim(),
      authorizedParties: authorizedParties(),
    });
    return { userId: claims.sub, claims };
  } catch (err) {
    // Surface the real Clerk failure reason instead of a blanket message. Clerk's
    // TokenVerificationError carries a `.reason` (e.g. token-expired,
    // token-invalid-signature, jwk-remote-failed-to-load) that distinguishes an
    // expired token from a JWKS-fetch failure — critical for diagnosis.
    const reason = err?.reason || err?.message || 'unknown';
    console.error('[auth] verifyToken failed:', reason, err);
    throw new HttpError(401, 'Invalid or expired session', {
      error: 'auth_failed',
      reason,
    });
  }
}

// True when the user's Stripe subscription (mirrored into Clerk by the webhook) is
// active. publicMetadata.plan is the only field the webhook flips to 'premium'.
export function isPremiumUser(user) {
  return user?.publicMetadata?.plan === 'premium';
}

// requireUser + load the full Clerk user so callers can branch on plan. Returns
// { userId, user, premium }.
export async function getEntitlement(req) {
  const { userId } = await requireUser(req);
  const user = await clerkClient.users.getUser(userId);
  return { userId, user, premium: isPremiumUser(user) };
}

// requireUser + assert premium, else 403. Use for premium-only endpoints.
export async function requirePremium(req) {
  const ent = await getEntitlement(req);
  if (!ent.premium) {
    throw new HttpError(403, 'Premium required', { error: 'premium_required', upsell: true });
  }
  return ent;
}

const utcDay = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const quotaKey = (userId) => `mockdraft:count:${userId}:${utcDay()}`;

// How many mock drafts the user has started today (without consuming one).
export async function getMockUsage(userId) {
  const used = Number(await redis.get(quotaKey(userId))) || 0;
  return { used, limit: FREE_DAILY_MOCKS, remaining: Math.max(0, FREE_DAILY_MOCKS - used) };
}

// Atomically claim one of today's free mock-draft slots. Throws 403 (with an upsell
// payload) when the daily limit is already spent. Premium callers skip this entirely.
export async function consumeMockQuota(userId) {
  const key = quotaKey(userId);
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, QUOTA_TTL_SECONDS);
  if (n > FREE_DAILY_MOCKS) {
    throw new HttpError(403, 'Daily mock draft limit reached', {
      error: 'mock_limit_reached',
      upsell: true,
      limit: FREE_DAILY_MOCKS,
    });
  }
  return n;
}

// Standard error responder for the gated endpoints.
export function sendError(res, err) {
  const status = err instanceof HttpError ? err.status : 500;
  const payload = err instanceof HttpError ? err.payload : { error: err.message };
  return res.status(status).json(payload);
}
