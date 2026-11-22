import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { kvStore } from '../src/store.js';
import { createFakeKv } from './helpers/fake-kv.js';

describe('kvStore', () => {
  it('returns empty defaults', async () => {
    const store = kvStore(createFakeKv());
    assert.deepEqual(await store.getRuns(), []);
    assert.deepEqual(await store.getMeta(), {});
  });

  it('round-trips runs under the activities key', async () => {
    const kv = createFakeKv();
    const store = kvStore(kv);
    await store.putRuns([{ id: 1 }]);
    assert.deepEqual(await store.getRuns(), [{ id: 1 }]);
    assert.equal(kv.data.get('activities').value, '[{"id":1}]');
  });

  it('round-trips meta under the meta key', async () => {
    const kv = createFakeKv();
    const store = kvStore(kv);
    await store.putMeta({ lastStatus: 'ok' });
    assert.deepEqual(await store.getMeta(), { lastStatus: 'ok' });
    assert.equal(kv.data.get('meta').value, '{"lastStatus":"ok"}');
  });

  it('locks with a ttl and unlocks', async () => {
    const kv = createFakeKv();
    const store = kvStore(kv);
    assert.equal(await store.isLocked(), false);
    await store.lock('holder', 300);
    assert.equal(await store.isLocked(), true);
    const write = kv.writes.find((w) => w.key === 'sync_lock');
    assert.equal(write.options.expirationTtl, 300);
    await store.unlock();
    assert.equal(await store.isLocked(), false);
  });

  it('returns null when no token is stored', async () => {
    const store = kvStore(createFakeKv());
    assert.equal(await store.getToken(), null);
  });

  it('round-trips the token with a ttl under garmin_token', async () => {
    const kv = createFakeKv();
    const store = kvStore(kv);
    await store.putToken({ token: 't', expiresAt: 5 }, 120);
    assert.deepEqual(await store.getToken(), { token: 't', expiresAt: 5 });
    const write = kv.writes.find((w) => w.key === 'garmin_token');
    assert.equal(write.options.expirationTtl, 120);
  });

  it('deletes the token', async () => {
    const store = kvStore(createFakeKv());
    await store.putToken({ token: 't', expiresAt: 5 }, 120);
    await store.deleteToken();
    assert.equal(await store.getToken(), null);
  });
});
