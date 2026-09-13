// Deployment configuration only; never accept isolation claims from a request.
const PRODUCTION_PROJECT = 'prj_A28CS5v2BGhbNTrRJxb3IhGr8XPw';
export function previewConfig(env = process.env) {
  const project = env.FE_PREVIEW_PROJECT_ID;
  const raw = env.ESPN_CREDENTIAL_ENCRYPTION_KEY || '';
  const key = Buffer.from(raw, 'base64');
  let url;
  try { url = new URL(env.FE_PREVIEW_REDIS_REST_URL); } catch { return null; }
  if (env.VERCEL_ENV !== 'preview' || env.FE_PREVIEW_ISOLATED !== 'true'
    || !project || project === PRODUCTION_PROJECT || env.VERCEL_PROJECT_ID !== project
    || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || !url.hostname.endsWith('.upstash.io')
    || !env.FE_PREVIEW_REDIS_READ_ONLY_TOKEN || !env.FE_PREVIEW_ESPN_CREDENTIAL_TOKEN
    || key.length !== 32 || key.toString('base64') !== raw
    || env.ESPN_CREDENTIAL_ENCRYPTION_PREVIOUS_KEY
    || ['KV_REST_API_URL','KV_REST_API_TOKEN','KV_REST_API_READ_ONLY_TOKEN','KV_URL','REDIS_URL',
      'UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN'].some(k => env[k])) return null;
  return { url: url.origin, readToken: env.FE_PREVIEW_REDIS_READ_ONLY_TOKEN,
    credentialToken: env.FE_PREVIEW_ESPN_CREDENTIAL_TOKEN, project };
}
