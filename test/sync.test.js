import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { kvStore } from '../src/store.js';
import { createFakeKv } from './helpers/fake-kv.js';
import { RECORD_VERSION, mergeRuns, planFetch, statusOf, nextBackfill, nextMeta, syncRuns } from '../src/sync.js';

function run(id, startLocal, extra = {}) {
  return { id, name: 'R' + id, type: 'running', startLocal, distance: 5000, duration: 1800, elevationGain: 10, ...extra };
}

const NOW = Date.UTC(2026, 10, 21, 12);
const now = () => NOW;

function fakeGarmin(pages, finalResult = {}) {
  const count = pages.reduce((n, p) => n + p.length, 0);
  const fake = {
    calls: [],
    tokenInfo: async () => null,
    async fetchRuns(args) {
      fake.calls.push(args);
      for (let i = 0; i < pages.length; i++) {
        await args.onPage(pages[i], { hasMore: i < pages.length - 1 || Boolean(finalResult.forceMore) });
      }
      if (finalResult.ok === false) return { ...finalResult, pages: pages.length, fetched: count };
      return { ok: true, pages: pages.length, fetched: count, complete: finalResult.complete !== false };
    },
  };
  return fake;
}

function writesFor(kv, key) {
  return kv.writes.filter((w) => w.key === key).length;
}

function dayKey(n) {
  const d = new Date(Date.UTC(2026, 10, 1) - n * 86400000);
  return d.toISOString().slice(0, 10);
}

function makePages(pageCount, perPage) {
  const pages = [];
  let id = 1;
  for (let p = 0; p < pageCount; p++) {
    const page = [];
    for (let i = 0; i < perPage; i++) {
      page.push(run(id, dayKey(id) + ' 08:00:00'));
      id++;
    }
    pages.push(page);
  }
  return pages;
}

describe('mergeRuns', () => {
  it('counts added and updated and sorts newest first', () => {
    const a = run(1, '2026-11-01 08:00:00');
    const b = run(2, '2026-11-05 08:00:00');
    const merged = mergeRuns([a, b], [b, { ...a, distance: 9000 }, run(3, '2026-11-10 08:00:00')]);
    assert.equal(merged.added, 1);
    assert.equal(merged.updated, 1);
    assert.equal(merged.changed, true);
    assert.deepEqual(merged.runs.map((r) => r.id), [3, 2, 1]);
  });

  it('reports no change for identical records', () => {
    const a = run(1, '2026-11-01 08:00:00');
    const merged = mergeRuns([a], [{ ...a }]);
    assert.equal(merged.changed, false);
    assert.equal(merged.added, 0);
    assert.equal(merged.updated, 0);
  });
});

describe('planFetch', () => {
  it('plans a fresh backfill', () => {
    assert.deepEqual(planFetch({}, []), { mode: 'backfill', endDate: null });
  });

  it('resumes a backfill from its cursor', () => {
    assert.equal(planFetch({ backfill: { done: false, endDate: '2025-01-10' } }, []).endDate, '2025-01-10');
  });

  it('plans an incremental fetch with overlap', () => {
    const runs = [run(1, '2026-11-19 18:20:15')];
    assert.deepEqual(planFetch({ backfill: { done: true }, recordVersion: RECORD_VERSION }, runs), { mode: 'incremental', startDate: '2026-11-16' });
  });

  it('has no start date when nothing is stored', () => {
    assert.equal(planFetch({ backfill: { done: true }, recordVersion: RECORD_VERSION }, []).startDate, null);
  });
});

describe('statusOf', () => {
  it('reloads the history when records are from an older version', () => {
    const plan = planFetch({ backfill: { done: true, completedAt: 'x' }, recordVersion: RECORD_VERSION - 1 }, [run(1, '2026-11-19 08:00:00')]);
    assert.deepEqual(plan, { mode: 'backfill', endDate: null });
    assert.deepEqual(planFetch({ backfill: { done: true } }, []), { mode: 'backfill', endDate: null });
  });

  it('stamps the record version only when the backfill is done', () => {
    const base = { result: { ok: true, complete: true, pages: 1, fetched: 1 }, trigger: 't', added: 0, updated: 0, storedRuns: 1, nowMs: NOW };
    assert.equal(nextMeta({}, { ...base, backfill: { done: true } }).recordVersion, RECORD_VERSION);
    const partial = nextMeta({ recordVersion: 1 }, { ...base, backfill: { done: false, endDate: '2025-01-01' } });
    assert.equal(partial.recordVersion, 1);
  });

  it('maps successes', () => {
    assert.equal(statusOf({ ok: true, complete: true }), 'ok');
    assert.equal(statusOf({ ok: true, complete: false }), 'partial');
  });

  it('maps failure reasons', () => {
    for (const reason of ['key_invalid', 'rate_limited', 'not_configured']) {
      assert.equal(statusOf({ ok: false, reason }), reason);
    }
    assert.equal(statusOf({ ok: false, reason: 'network' }), 'network_error');
    assert.equal(statusOf({ ok: false, reason: 'http_error' }), 'error');
  });
});

describe('nextBackfill', () => {
  const previous = { done: false, endDate: '2025-01-01' };

  it('leaves incremental syncs alone', () => {
    const backfill = { done: true };
    assert.equal(nextBackfill({ backfill }, { mode: 'incremental' }, { ok: true, complete: true }, null, NOW), backfill);
  });

  it('completes a finished backfill', () => {
    assert.deepEqual(nextBackfill({}, { mode: 'backfill' }, { ok: true, complete: true }, '2020-01-01', NOW), {
      done: true,
      completedAt: new Date(NOW).toISOString(),
    });
  });

  it('keeps the cursor of a failed backfill', () => {
    assert.deepEqual(nextBackfill({ backfill: previous }, { mode: 'backfill' }, { ok: false }, '2024-05-01', NOW), {
      done: false,
      endDate: '2024-05-01',
    });
  });

  it('keeps the previous backfill when there is no cursor', () => {
    assert.deepEqual(nextBackfill({ backfill: previous }, { mode: 'backfill' }, { ok: false }, null, NOW), previous);
  });
});

describe('nextMeta', () => {
  it('clears errors on success', () => {
    const iso = new Date(NOW).toISOString();
    const meta = nextMeta(
      { lastError: { message: 'old' }, blockedUntil: 'x' },
      { result: { ok: true, complete: true, pages: 2, fetched: 5 }, trigger: 'manual', added: 3, updated: 1, storedRuns: 9, backfill: { done: true }, nowMs: NOW },
    );
    assert.equal(meta.lastError, null);
    assert.equal(meta.blockedUntil, null);
    assert.equal(meta.lastSync, iso);
    assert.equal(meta.lastAttempt, iso);
    assert.deepEqual(meta.lastResult, { added: 3, updated: 1, pages: 2, fetched: 5 });
    assert.equal(meta.storedRuns, 9);
  });

  it('blocks after a rate limit', () => {
    const result = { ok: false, reason: 'rate_limited', retryAfterSeconds: 120, message: 'm', pages: 1, fetched: 100 };
    const meta = nextMeta(
      { lastSync: 'earlier' },
      { result, trigger: 'cron', added: 0, updated: 0, storedRuns: 0, backfill: undefined, nowMs: NOW },
    );
    assert.equal(meta.lastStatus, 'rate_limited');
    assert.equal(meta.blockedUntil, new Date(NOW + 120000).toISOString());
    assert.equal(meta.lastError.message, 'm');
    assert.equal(meta.lastSync, 'earlier');
  });
});

describe('syncRuns', () => {
  it('backfills 12 pages with checkpointed writes', async () => {
    const kv = createFakeKv();
    const store = kvStore(kv);
    const garmin = fakeGarmin(makePages(12, 3));
    const { result, runs } = await syncRuns({ store, garmin, trigger: 'manual', now });
    assert.equal(result.status, 'ok');
    assert.equal(result.added, 36);
    assert.equal(result.backfillDone, true);
    assert.equal(writesFor(kv, 'activities'), 3);
    assert.equal(writesFor(kv, 'meta'), 3);
    const meta = await store.getMeta();
    assert.equal(meta.backfill.done, true);
    assert.equal(meta.storedRuns, 36);
    assert.equal(runs.length, 36);
    assert.deepEqual(runs, await store.getRuns());
  });

  it('keeps a cursor when a 429 interrupts the backfill', async () => {
    const kv = createFakeKv();
    const store = kvStore(kv);
    const pages = makePages(7, 3);
    const garmin = fakeGarmin(pages, {
      ok: false,
      reason: 'rate_limited',
      retryAfterSeconds: 60,
      message: 'Garmin rate limit reached',
      forceMore: true,
    });
    const { result } = await syncRuns({ store, garmin, trigger: 'cron', now });
    assert.equal(result.status, 'rate_limited');
    const meta = await store.getMeta();
    const oldest = pages[6].map((r) => r.startLocal.slice(0, 10)).sort()[0];
    assert.deepEqual(meta.backfill, { done: false, endDate: oldest });
    assert.equal(meta.blockedUntil, new Date(NOW + 60000).toISOString());
    assert.equal((await store.getRuns()).length, 21);
  });

  it('skips while blocked', async () => {
    const store = kvStore(createFakeKv());
    await store.putMeta({ blockedUntil: new Date(NOW + 60000).toISOString() });
    const garmin = fakeGarmin([]);
    const { result } = await syncRuns({ store, garmin, trigger: 'cron', now });
    assert.equal(result.status, 'rate_limited');
    assert.equal(garmin.calls.length, 0);
  });

  it('resumes a backfill from the stored cursor', async () => {
    const store = kvStore(createFakeKv());
    await store.putMeta({ backfill: { done: false, endDate: '2024-05-01' } });
    const garmin = fakeGarmin([]);
    await syncRuns({ store, garmin, trigger: 'cron', now });
    assert.equal(garmin.calls[0].endDate, '2024-05-01');
    assert.equal('startDate' in garmin.calls[0], false);
  });

  it('runs incrementally with overlap', async () => {
    const store = kvStore(createFakeKv());
    await store.putMeta({ backfill: { done: true }, recordVersion: RECORD_VERSION });
    await store.putRuns([run(1, '2026-11-19 08:00:00'), run(2, '2026-11-17 08:00:00')]);
    const garmin = fakeGarmin([[run(2, '2026-11-17 08:00:00', { distance: 6000 }), run(3, '2026-11-20 07:00:00')]]);
    const { result } = await syncRuns({ store, garmin, trigger: 'cron', now });
    assert.equal(garmin.calls[0].startDate, '2026-11-16');
    assert.equal(result.added, 1);
    assert.equal(result.updated, 1);
    assert.equal((await store.getRuns()).length, 3);
  });

  it('reports busy when locked', async () => {
    const store = kvStore(createFakeKv());
    await store.lock('other', 300);
    const garmin = fakeGarmin([]);
    const { result } = await syncRuns({ store, garmin, trigger: 'cron', now });
    assert.equal(result.status, 'busy');
    assert.equal(garmin.calls.length, 0);
    assert.equal(await store.isLocked(), true);
  });

  it('records unexpected errors and releases the lock', async () => {
    const store = kvStore(createFakeKv());
    const garmin = {
      tokenInfo: async () => null,
      async fetchRuns() {
        throw new Error('boom');
      },
    };
    const { result } = await syncRuns({ store, garmin, trigger: 'cron', now });
    assert.equal(result.status, 'error');
    assert.ok(result.message.includes('boom'));
    assert.equal((await store.getMeta()).lastStatus, 'error');
    assert.equal(await store.isLocked(), false);
  });

  it('leaves stored runs untouched on a key failure', async () => {
    const kv = createFakeKv();
    const store = kvStore(kv);
    await store.putMeta({ backfill: { done: true }, recordVersion: RECORD_VERSION });
    await store.putRuns([run(1, '2026-11-19 08:00:00'), run(2, '2026-11-17 08:00:00')]);
    const garmin = fakeGarmin([], { ok: false, reason: 'key_invalid', message: 'Garmin key invalid or expired' });
    const { result } = await syncRuns({ store, garmin, trigger: 'cron', now });
    assert.equal(result.status, 'key_invalid');
    assert.equal((await store.getRuns()).length, 2);
    assert.equal(writesFor(kv, 'activities'), 1);
  });
});
