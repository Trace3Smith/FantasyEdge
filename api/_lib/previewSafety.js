// Preview certification is read-only. No request flag can bypass this policy.
export const isPreview = () => process.env.VERCEL_ENV === 'preview';
const espnReads = new Set(['status', 'myEdge', 'leagueContext', 'leagues']);
export function blockPreview(req, res, surface) {
  if (!isPreview()) return false;
  if (surface === 'espn' && req.method === 'POST' && espnReads.has(req.body?.action)) {
    if (process.env.KV_REST_API_READ_ONLY_TOKEN) return false;
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(503).json({ error: 'preview_read_only_storage_required' });
    return true;
  }
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(403).json({ error: 'preview_read_only', message: 'This operation is disabled in the read-only preview.' });
  return true;
}
