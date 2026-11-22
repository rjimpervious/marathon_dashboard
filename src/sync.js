import { shiftDateKey } from './stats.js';

const LOCK_TTL_SECONDS = 300;
const MAX_PAGES_PER_SYNC = 40;
const INCREMENTAL_OVERLAP_DAYS = 3;
const CHECKPOINT_EVERY_PAGES = 5;
export const RECORD_VERSION = 2;
const STATUS_BY_REASON = {
  key_invalid: 'key_invalid',
  rate_limited: 'rate_limited',
  network: 'network_error',
  not_configured: 'not_configured',
};

function sortNewestFirst(records) {
  return records.sort((a, b) => (a.startLocal < b.startLocal ? 1 : a.startLocal > b.startLocal ? -1 : 0));
}

function oldestDate(records) {
  return records.map((r) => String(r.startLocal || '').slice(0, 10)).filter(Boolean).sort()[0] || null;
}

export function mergeRuns(stored, incoming) {
  const byId = new Map(stored.map((r) => [r.id, r]));
  let added = 0;
  let updated = 0;
  for (const record of incoming) {
    const previous = byId.get(record.id);
    if (!previous) added++;
    else if (JSON.stringify(previous) !== JSON.stringify(record)) updated++;
    byId.set(record.id, record);
  }
  return { runs: sortNewestFirst([...byId.values()]), added, updated, changed: added + updated > 0 };
}

export function planFetch(meta, runs) {
  if (!(meta.backfill && meta.backfill.done && meta.recordVersion === RECORD_VERSION)) {
    return { mode: 'backfill', endDate: meta.backfill && meta.backfill.endDate ? meta.backfill.endDate : null };
  }
  const newest = runs.reduce((best, r) => (!best || r.startLocal > best.startLocal ? r : best), null);
  return { mode: 'incremental', startDate: newest ? shiftDateKey(newest.startLocal, -INCREMENTAL_OVERLAP_DAYS) : null };
}

export function statusOf(result) {
  if (result.ok) return result.complete ? 'ok' : 'partial';
  return STATUS_BY_REASON[result.reason] || 'error';
}

export function nextBackfill(meta, plan, result, cursor, nowMs) {
  if (plan.mode !== 'backfill') return meta.backfill;
  if (result.ok && result.complete) return { done: true, completedAt: new Date(nowMs).toISOString() };
  return cursor ? { done: false, endDate: cursor } : meta.backfill;
}

export function nextMeta(meta, { result, trigger, added, updated, storedRuns, backfill, nowMs }) {
  const at = new Date(nowMs).toISOString();
  const status = statusOf(result);
  const next = {
    ...meta,
    backfill,
    recordVersion: backfill && backfill.done ? RECORD_VERSION : meta.recordVersion,
    lastAttempt: at,
    lastStatus: status,
    lastTrigger: trigger,
    lastResult: { added, updated, pages: result.pages, fetched: result.fetched },
    storedRuns,
  };
  if (result.ok) {
    next.lastSync = at;
    next.lastError = null;
    next.blockedUntil = null;
  } else {
    next.lastError = { at, status, message: result.message };
    if (result.reason === 'rate_limited') {
      next.blockedUntil = new Date(nowMs + result.retryAfterSeconds * 1000).toISOString();
    }
  }
  return next;
}

async function performSync({ store, garmin, trigger, meta, now }) {
  let runs = await store.getRuns();
  const plan = planFetch(meta, runs);
  let added = 0;
  let updated = 0;
  let dirty = false;
  let cursor = null;
  let pagesSinceCheckpoint = 0;

  const checkpoint = async () => {
    if (dirty) await store.putRuns(runs);
    dirty = false;
    if (plan.mode === 'backfill' && cursor) await store.putMeta({ ...meta, backfill: { done: false, endDate: cursor } });
    pagesSinceCheckpoint = 0;
  };

  const onPage = async (records, { hasMore }) => {
    const merged = mergeRuns(runs, records);
    runs = merged.runs;
    added += merged.added;
    updated += merged.updated;
    dirty = dirty || merged.changed;
    const oldest = oldestDate(records);
    if (oldest && (!cursor || oldest < cursor)) cursor = oldest;
    pagesSinceCheckpoint++;
    if (hasMore && pagesSinceCheckpoint >= CHECKPOINT_EVERY_PAGES) await checkpoint();
  };

  const range = plan.mode === 'backfill' ? { endDate: plan.endDate } : { startDate: plan.startDate };
  const result = await garmin.fetchRuns({ ...range, maxPages: MAX_PAGES_PER_SYNC, onPage });
  if (dirty) await store.putRuns(runs);

  const nowMs = now();
  const finalMeta = nextMeta(meta, {
    result,
    trigger,
    added,
    updated,
    storedRuns: runs.length,
    backfill: nextBackfill(meta, plan, result, cursor, nowMs),
    nowMs,
  });
  await store.putMeta(finalMeta);

  const status = finalMeta.lastStatus;
  const summary = '[sync] ' + trigger + ': ' + status + ', ' + added + ' new, ' + updated + ' updated, ' + runs.length + ' stored';
  if (result.ok) console.log(summary);
  else console.warn(summary + ' (' + result.message + ')');

  return {
    result: {
      status,
      trigger,
      at: finalMeta.lastAttempt,
      added,
      updated,
      storedRuns: runs.length,
      pages: result.pages,
      message: result.ok ? null : result.message,
      backfillDone: Boolean(finalMeta.backfill && finalMeta.backfill.done),
    },
    runs,
    meta: finalMeta,
  };
}

export async function syncRuns({ store, garmin, trigger, now = Date.now }) {
  const at = new Date(now()).toISOString();
  const meta = await store.getMeta();
  if (meta.blockedUntil && Date.parse(meta.blockedUntil) > now()) {
    console.warn('[sync] ' + trigger + ': skipped, rate limited until ' + meta.blockedUntil);
    return {
      result: { status: 'rate_limited', trigger, at, added: 0, updated: 0, message: 'Rate limited until ' + meta.blockedUntil },
      runs: await store.getRuns(),
      meta,
    };
  }
  if (await store.isLocked()) {
    console.log('[sync] ' + trigger + ': skipped, another sync is running');
    return { result: { status: 'busy', trigger, at, added: 0, updated: 0 }, runs: await store.getRuns(), meta };
  }

  await store.lock(at, LOCK_TTL_SECONDS);
  try {
    return await performSync({ store, garmin, trigger, meta, now });
  } catch (err) {
    const message = 'Unexpected sync error: ' + (err && err.message ? err.message : String(err));
    console.error('[sync] ' + trigger + ': ' + message);
    const latest = await store.getMeta();
    const errorMeta = { ...latest, lastAttempt: at, lastStatus: 'error', lastError: { at, status: 'error', message } };
    await store.putMeta(errorMeta);
    return { result: { status: 'error', trigger, at, added: 0, updated: 0, message }, runs: await store.getRuns(), meta: errorMeta };
  } finally {
    await store.unlock();
  }
}

export function garminSource({ store, garmin, now = Date.now }) {
  return {
    name: 'garmin',
    runs() {
      return store.getRuns();
    },
    meta() {
      return store.getMeta();
    },
    async tokenExpiresAt() {
      const info = await garmin.tokenInfo();
      return info ? new Date(info.expiresAt * 1000).toISOString() : null;
    },
    sync(trigger) {
      return syncRuns({ store, garmin, trigger, now });
    },
  };
}
