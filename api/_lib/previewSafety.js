import { previewConfig } from './previewIsolation.js';
// Preview is read-only except isolated credential connect/disconnect. No request flag bypass.
export const isPreview = () => process.env.VERCEL_ENV === 'preview';
const espnReads = new Set(['status', 'myEdge', 'leagueContext', 'leagues', 'connect', 'disconnect']);
export function blockPreview(req, res, surface) {
  if (!isPreview()) return false;
  res.setHeader('Cache-Control', 'private, no-store');
  if (surface === 'espn' && req.method === 'POST' && espnReads.has(req.body?.action)) {
    if (previewConfig()) return false;
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(503).json({ error: 'preview_read_only_storage_required' });
    return true;
  }
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(403).json({ error: 'preview_read_only', message: 'This operation is disabled in the read-only preview.' });
  return true;
}
