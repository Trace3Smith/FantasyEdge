// Operator tool. Default inventory is read-only. No ESPN calls or secret diagnostics.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptCredentials, decryptCredentials, migrateLegacyCredentials } from '../api/_lib/espnCredentials.js';

export function parseOptions(args) {
  let mode = 'inventory', limit = Infinity;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply' || arg === '--verify') {
      if (mode !== 'inventory') throw new Error('Choose one operation');
      mode = arg.slice(2);
    } else if (arg === '--limit') {
      const value = args[++i];
      if (limit !== Infinity || !/^[1-9]\d*$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) {
        throw new Error('Invalid limit');
      }
      limit = Number(value);
    } else throw new Error('Unknown option');
  }
  if (limit !== Infinity && mode !== 'apply') throw new Error('Limit requires apply');
  return { mode, limit };
}

export async function runMigration(redis, options = parseOptions([])) {
  const { mode, limit } = options;
  if (!['inventory', 'verify', 'apply'].includes(mode) ||
      !(limit === Infinity || (Number.isSafeInteger(limit) && limit > 0)) ||
      (limit !== Infinity && mode !== 'apply')) throw new Error('Invalid options');
  // Synthetic round-trip only. Validate current AND optional previous key before Redis access.
  if (mode !== 'inventory') {
    const probe = { espn_s2: 'local-preflight', swid: 'local-preflight' };
    decryptCredentials('migration-preflight', encryptCredentials('migration-preflight', probe));
  }
  const counts = { mode, complete: false, legacy: 0, encrypted: 0, readable: 0,
    expired: 0, unreadable: 0, attempted: 0, migrated: 0, changedDuringRead: 0, invalid: 0 };
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, { match: 'espn:creds:*', count: 100 });
    cursor = String(next);
    for (const key of keys) {
      const value = await redis.get(key);
      if (!value) continue;
      const userId = key.slice('espn:creds:'.length);
      if (value.version === 1) {
        counts.encrypted++;
        if (mode === 'verify') {
          try {
            if (decryptCredentials(userId, value)) counts.readable++;
            else counts.expired++;
          } catch { counts.unreadable++; }
        }
        continue;
      }
      if (value.version != null || !value.espn_s2 || !value.swid) { counts.invalid++; continue; }
      counts.legacy++;
      if (mode === 'apply') {
        counts.attempted++;
        if (await migrateLegacyCredentials(redis, userId, value)) counts.migrated++;
        else counts.changedDuringRead++;
        // Bound attempts, including races. Restart from cursor zero on the next run.
        // Conservatively incomplete even if this happened to be the final record.
        if (counts.attempted >= limit) return counts;
      }
    }
  } while (cursor !== '0');
  counts.complete = true;
  return counts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const { redis } = await import('../api/_lib/kv.js');
    const counts = await runMigration(redis, options);
    console.log(JSON.stringify(counts));
    if (counts.invalid || counts.unreadable) process.exitCode = 1;
  } catch {
    console.error('Credential operation stopped; partial writes may have completed in apply mode. Check options, Redis and encryption configuration, then inventory again. No credential details logged.');
    process.exitCode = 1;
  }
}
