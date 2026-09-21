// Explicit operator tool. No env download, secret logging, provider calls or automatic run.
import { Redis } from '@upstash/redis';
import { beginBootstrap, captureManifest, importManifest, sealBootstrap, verifyBootstrap, activateBootstrap } from './lib/epoch-bootstrap.mjs';
try {
  const [operation, runId, ...extra] = process.argv.slice(2);
  if (extra.length || !runId || !['prepare','import','seal','verify','activate'].includes(operation)) throw Error('OPTIONS');
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) throw Error('CONFIG');
  if (process.env.VERCEL_ENV !== 'production' || process.env.FE_EPOCH_BOOTSTRAP_AUTHORIZED !== '1') throw Error('CONTEXT');
  const raw = new Redis({url:process.env.KV_REST_API_URL,token:process.env.KV_REST_API_TOKEN, retry:false, enableTelemetry:false});
  let counts = {};
  if (operation==='prepare') { await beginBootstrap(raw,runId); await captureManifest(raw,runId); }
  if (operation==='import') counts=await importManifest(raw,runId);
  if (operation==='seal') await sealBootstrap(raw,runId);
  if (operation==='verify') counts=await verifyBootstrap(raw,runId);
  if (operation==='activate') await activateBootstrap(raw,runId);
  console.log(JSON.stringify({passed:1,...counts}));
} catch { console.error('FAIL_BOOTSTRAP'); process.exitCode=1; }
