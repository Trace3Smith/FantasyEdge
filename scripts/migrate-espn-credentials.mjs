// Operator tool. Defaults to inventory only. Never prints keys, IDs or credentials.
// No live ESPN calls, lineup writes or subscription changes.
import { redis } from '../api/_lib/kv.js';
import { migrateLegacyCredentials } from '../api/_lib/espnCredentials.js';
const apply = process.argv.includes('--apply');
const counts = { mode: apply ? 'apply' : 'inventory', legacy: 0, encrypted: 0, migrated: 0, changedDuringRead: 0, invalid: 0 };
try {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, { match: 'espn:creds:*', count: 100 });
    cursor = String(next);
    for (const key of keys) {
      const value = await redis.get(key);
      if (!value) continue;
      if (value.version === 1) { counts.encrypted++; continue; }
      if (!value.espn_s2 || !value.swid) { counts.invalid++; continue; }
      counts.legacy++;
      if (apply) {
        if (await migrateLegacyCredentials(redis, key.slice('espn:creds:'.length), value)) counts.migrated++;
        else counts.changedDuringRead++;
      }
    }
  } while (cursor !== '0');
  console.log(JSON.stringify(counts));
} catch {
  console.error('Credential migration stopped; verify Redis and encryption configuration. No credential details logged.');
  process.exitCode = 1;
}
