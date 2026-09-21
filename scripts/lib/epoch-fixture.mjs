// Synthetic logical-store fixture; physical namespace/Lua tests use real Redis separately.
import { encryptCredentials } from '../../api/_lib/espnCredentials.js';
export function seedEpochCredential(store,user,credentials,generation=`fixture-${user}`) {
  const c={...credentials,storageEpoch:'e1',connectionId:generation};
  store.set(`espn:creds:${user}`,encryptCredentials(user,c));
  store.set(`espn:generation:${user}`,generation);
  store.set(`espn:ready:${user}`,'1');
  return c;
}
