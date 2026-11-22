const RUNS_KEY = 'activities';
const META_KEY = 'meta';
const LOCK_KEY = 'sync_lock';
const TOKEN_KEY = 'garmin_token';

export function kvStore(kv) {
  return {
    async getRuns() {
      return (await kv.get(RUNS_KEY, 'json')) || [];
    },
    putRuns(runs) {
      return kv.put(RUNS_KEY, JSON.stringify(runs));
    },
    async getMeta() {
      return (await kv.get(META_KEY, 'json')) || {};
    },
    putMeta(meta) {
      return kv.put(META_KEY, JSON.stringify(meta));
    },
    async isLocked() {
      return Boolean(await kv.get(LOCK_KEY));
    },
    lock(holder, ttlSeconds) {
      return kv.put(LOCK_KEY, holder, { expirationTtl: ttlSeconds });
    },
    unlock() {
      return kv.delete(LOCK_KEY);
    },
    async getToken() {
      return (await kv.get(TOKEN_KEY, 'json')) || null;
    },
    putToken(record, ttlSeconds) {
      return kv.put(TOKEN_KEY, JSON.stringify(record), { expirationTtl: ttlSeconds });
    },
    deleteToken() {
      return kv.delete(TOKEN_KEY);
    },
  };
}
