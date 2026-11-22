import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GARMIN_ENDPOINTS, compact, createGarminClient, isRun } from '../src/garmin.js';
import { kvStore } from '../src/store.js';
import { createFakeKv } from './helpers/fake-kv.js';

const NOW = Date.UTC(2026, 10, 21, 12);
const NOW_SECONDS = NOW / 1000;
const now = () => NOW;

function jwtWithExp(exp) {
  return 'h.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.s';
}

function fakeFetch(handlers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const handler = handlers[calls.length - 1];
    if (!handler) throw new Error('unexpected fetch call ' + calls.length);
    return handler(url, init);
  };
  fetch.calls = calls;
  return fetch;
}

function textResponse(text, status = 200, headers = {}) {
  return () => new Response(text, { status, headers });
}

function listResponse(list, status = 200) {
  return () => new Response(JSON.stringify(list), { status, headers: { 'Content-Type': 'application/json' } });
}

function rawRun(id, startTimeLocal, typeKey = 'running') {
  return {
    activityId: id,
    activityName: 'Run ' + id,
    activityType: {
      typeKey,
      typeId: typeKey === 'running' ? 1 : 6,
      parentTypeId: typeKey === 'running' ? 17 : 1,
    },
    startTimeLocal,
    distance: 10000.04,
    duration: 3000.06,
    elevationGain: 12.34,
    averageHR: 150.4,
  };
}

function runs(count, startId = 1) {
  return Array.from({ length: count }, (_, i) => rawRun(startId + i, '2026-11-01 07:00:00'));
}

function setup(handlers, { apiKey = 'test-key' } = {}) {
  const kv = createFakeKv();
  const store = kvStore(kv);
  const fetch = fakeFetch(handlers);
  const sleepCalls = [];
  const sleep = async (ms) => {
    sleepCalls.push(ms);
  };
  const client = createGarminClient({ apiKey, tokenStore: store, fetch, sleep, now });
  return { kv, store, fetch, sleepCalls, client };
}

const freshToken = () => textResponse(jwtWithExp(NOW_SECONDS + 86400));

describe('createGarminClient', () => {
  it('fetches a token and stores it with a ttl', async () => {
    const { client, fetch, kv } = setup([freshToken()]);
    const result = await client.getAccessToken();
    assert.equal(result.ok, true);
    assert.equal(result.fromCache, false);
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].url, GARMIN_ENDPOINTS.tokenUrl);
    assert.equal(fetch.calls[0].init.method, 'POST');
    assert.equal(fetch.calls[0].init.headers.Authorization, 'ApiKey test-key');
    assert.equal(fetch.calls[0].init.headers.Accept, '*/*');
    const write = kv.writes.find((w) => w.key === 'garmin_token');
    assert.equal(write.options.expirationTtl, 86400);
  });

  it('reuses a cached token', async () => {
    const { client, fetch, store } = setup([]);
    await store.putToken({ token: 'cached', expiresAt: NOW_SECONDS + 3600 }, 3600);
    const result = await client.getAccessToken();
    assert.equal(result.fromCache, true);
    assert.equal(result.token, 'cached');
    assert.equal(fetch.calls.length, 0);
  });

  it('fetches a new token inside the reuse margin', async () => {
    const { client, fetch, store } = setup([freshToken()]);
    await store.putToken({ token: 'old', expiresAt: NOW_SECONDS + 300 }, 300);
    const result = await client.getAccessToken();
    assert.equal(result.ok, true);
    assert.equal(result.fromCache, false);
    assert.equal(fetch.calls.length, 1);
  });

  it('reports not_configured without calling fetch', async () => {
    const { client, fetch } = setup([], { apiKey: 'YOUR_GARMIN_API_KEY' });
    const result = await client.getAccessToken();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_configured');
    assert.equal(fetch.calls.length, 0);
  });

  it('deletes the stored token when the key is rejected', async () => {
    const { client, store } = setup([textResponse('', 401)]);
    await store.putToken({ token: 'old', expiresAt: NOW_SECONDS - 10 }, 60);
    const result = await client.getAccessToken();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'key_invalid');
    assert.equal(await store.getToken(), null);
  });

  it('pages through runs and compacts them', async () => {
    const { client, fetch, sleepCalls } = setup([freshToken(), listResponse(runs(100)), listResponse(runs(37, 101))]);
    const pageCalls = [];
    const result = await client.fetchRuns({
      maxPages: 40,
      onPage: async (records, info) => {
        pageCalls.push({ records, info });
      },
    });
    assert.deepEqual(result, { ok: true, pages: 2, fetched: 137, complete: true });
    assert.equal(pageCalls.length, 2);
    assert.equal(pageCalls[0].info.hasMore, true);
    assert.equal(pageCalls[1].info.hasMore, false);
    assert.deepEqual(pageCalls[0].records[0], {
      id: 1,
      name: 'Run 1',
      type: 'running',
      startLocal: '2026-11-01 07:00:00',
      distance: 10000,
      duration: 3000.1,
      elevationGain: 12.3,
      averageHR: 150,
    });
    assert.deepEqual(sleepCalls, [1000]);
    assert.ok(fetch.calls[2].url.includes('start=100'));
    for (const call of fetch.calls.slice(1)) {
      assert.ok(call.url.includes('activityType=running'));
      assert.ok(call.url.includes('limit=100'));
      assert.ok(call.url.includes('sortOrder=desc'));
    }
  });

  it('passes date filters to the search', async () => {
    const { client, fetch } = setup([freshToken(), listResponse(runs(3))]);
    await client.fetchRuns({ startDate: '2026-11-01', endDate: '2026-11-20', maxPages: 1, onPage: async () => {} });
    assert.ok(fetch.calls[1].url.includes('startDate=2026-11-01'));
    assert.ok(fetch.calls[1].url.includes('endDate=2026-11-20'));
  });

  it('retries once with a new token after a 401 on search', async () => {
    const { client, fetch } = setup([freshToken(), textResponse('', 401), freshToken(), listResponse(runs(5))]);
    const result = await client.fetchRuns({ maxPages: 40, onPage: async () => {} });
    assert.equal(result.ok, true);
    assert.equal(result.complete, true);
    assert.equal(fetch.calls.length, 4);
  });

  it('gives up after a second 401', async () => {
    const { client } = setup([freshToken(), textResponse('', 401), freshToken(), textResponse('', 401)]);
    const result = await client.fetchRuns({ maxPages: 40, onPage: async () => {} });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'key_invalid');
    assert.equal(result.complete, false);
  });

  it('reports rate limiting with retry-after', async () => {
    const { client } = setup([freshToken(), listResponse(runs(100)), textResponse('', 429, { 'Retry-After': '120' })]);
    const result = await client.fetchRuns({ maxPages: 40, onPage: async () => {} });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'rate_limited');
    assert.equal(result.retryAfterSeconds, 120);
    assert.equal(result.pages, 1);
    assert.equal(result.fetched, 100);
    assert.equal(result.complete, false);
  });

  it('reports a network error on search', async () => {
    const { client } = setup([
      freshToken(),
      () => {
        throw new Error('boom');
      },
    ]);
    const result = await client.fetchRuns({ maxPages: 40, onPage: async () => {} });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'network');
    assert.ok(result.message.includes('Activity request failed: boom'));
  });

  it('stops at maxPages without completing', async () => {
    const { client } = setup([freshToken(), listResponse(runs(100)), listResponse(runs(100, 101))]);
    const result = await client.fetchRuns({ maxPages: 2, onPage: async () => {} });
    assert.equal(result.ok, true);
    assert.equal(result.pages, 2);
    assert.equal(result.complete, false);
  });
});

describe('isRun and compact', () => {
  it('keeps the detail fields Garmin sends and drops the rest', () => {
    const full = compact({
      ...rawRun(1, '2026-11-01 08:00:00'),
      maxHR: 171.4,
      movingDuration: 2990.04,
      averageRunningCadenceInStepsPerMinute: 167.6,
      avgStrideLength: 101.26,
      calories: 702.4,
      elevationLoss: 14.44,
      vO2MaxValue: 48,
      locationName: 'Somewhere',
    });
    assert.deepEqual(
      [full.maxHR, full.movingDuration, full.cadence, full.strideLength, full.calories, full.elevationLoss, full.vo2max, full.locationName],
      [171, 2990, 168, 101.3, 702, 14.4, 48, 'Somewhere'],
    );
    const plain = compact(rawRun(2, '2026-11-02 08:00:00'));
    for (const key of ['maxHR', 'movingDuration', 'cadence', 'locationName', 'vo2max']) assert.equal(key in plain, false, key);
  });

  it('classifies run types and omits missing heart rate', () => {
    assert.equal(isRun(rawRun(1, '2026-11-01 07:00:00', 'trail_running')), true);
    assert.equal(isRun({ activityType: { typeKey: 'cycling', typeId: 2, parentTypeId: 17 } }), false);
    const record = compact({ ...rawRun(1, '2026-11-01 07:00:00'), averageHR: null });
    assert.equal('averageHR' in record, false);
  });
});
