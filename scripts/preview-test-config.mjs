export function configurePreview() {
 for(const k of ['KV_REST_API_URL','KV_REST_API_TOKEN','KV_REST_API_READ_ONLY_TOKEN','KV_URL','REDIS_URL','UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN','ESPN_CREDENTIAL_ENCRYPTION_PREVIOUS_KEY'])delete process.env[k];
 Object.assign(process.env,{VERCEL_ENV:'preview',VERCEL_PROJECT_ID:'prj_test',FE_PREVIEW_PROJECT_ID:'prj_test',FE_PREVIEW_ISOLATED:'true',
 FE_PREVIEW_REDIS_REST_URL:'https://isolated-test.upstash.io',FE_PREVIEW_REDIS_READ_ONLY_TOKEN:'test-read',FE_PREVIEW_ESPN_CREDENTIAL_TOKEN:'test-credential',ESPN_CREDENTIAL_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64')});
}
