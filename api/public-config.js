// Public bootstrap config for the frontend. Returns only values that are safe to
// expose to the browser (the Clerk publishable key is public by design). Keeping it
// in an endpoint — rather than hardcoded in HTML — lets dev and prod use different
// Clerk instances without editing the static pages.
export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.json({
    clerkPublishableKey: (process.env.CLERK_PUBLISHABLE_KEY || '').trim(),
  });
}
