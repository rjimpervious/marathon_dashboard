# Plan 005: Deepen the sync module: a pure core, checkpointed writes and an injected clock

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: this plan builds on plan 004, which rewrites the
> in-scope files. So instead of file hashes:
> 1. `plans/README.md` must show plan 004 as DONE. If not, STOP.
> 2. Confirm the post-004 state described in "Current state": run
>    `grep -n "export function garminSource({ store, garmin })" src/sync.js` → 1 match;
>    `grep -n "garmin.fetchRuns({" src/sync.js` → 2 matches;
>    `grep -c "import" src/sync.js` → 1.
> 3. `npm test` → exit 0 before you change anything.
> Any mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (it restructures the code that writes stored runs; the test suite plus a sample-mode smoke test guard it, and the owner runs one real sync)
- **Depends on**: 004 (needs the injectable Garmin client and the `onPage(records, { hasMore })` signature), 003 (test baseline)
- **Category**: tech-debt, tests, perf
- **Planned at**: no git repository, 2026-11-21 (state after plan 004)

## Why this matters

`performSync` in `src/sync.js` mixes three jobs:
- deciding: merge and dedupe, backfill or incremental, the backfill cursor, the next sync meta
- persisting: two KV writes after **every** page
- orchestrating: fetch, lock, rate-limit block

It also reads the clock directly in five places. Today none of the deciding logic can be
tested without running the whole thing against KV.

Two concrete costs:
1. **Untested merge, cursor and meta rules.** These are the code paths most likely to
   corrupt or lose stored runs.
2. **Too many KV writes to one key.** Deployed Workers KV allows about one write per
   second to the same key. A backfill writes `activities` and `meta` once per page (about
   every 1.3 s). At the end it writes `meta` again milliseconds after the last checkpoint,
   which can make KV reject the final write.

After this plan:
- `mergeRuns`, `planFetch`, `nextBackfill`, `nextMeta` and `statusOf` are pure and tested.
- `syncRuns` only orders I/O around them.
- Writes are checkpointed every 5 pages, and only when another page follows, which
  leaves at least one page delay (≥ 1 s) before the final write.
- The clock is injected.
- `POST /api/refresh` builds its response from the state the sync just wrote instead of
  re-reading KV, which on deployed KV can briefly return stale data.

## Current state (after plan 004)

- `src/sync.js`:
  - imports only `{ shiftDateKey }` from `./stats.js`
  - constants `LOCK_TTL_SECONDS = 300`, `MAX_PAGES_PER_SYNC = 40`, `INCREMENTAL_OVERLAP_DAYS = 3`, and
    `STATUS_BY_REASON = { key_invalid: 'key_invalid', rate_limited: 'rate_limited', network: 'network_error', not_configured: 'not_configured' }`
  - `sortNewestFirst(records)`
  - `async function performSync(garmin, store, trigger, meta)`. Inside it, a closure
    `merge(records)` counts `added` / `updated` (an update means `JSON.stringify(previous) !== JSON.stringify(record)`)
    and calls `store.putRuns(sortNewestFirst([...byId.values()]))` whenever something changed.
    - **Backfill** (when `!meta.backfill?.done`): calls
      `garmin.fetchRuns({ endDate: resumeEndDate, maxPages: MAX_PAGES_PER_SYNC, onPage: async (records) => { … } })`.
      Each page merges, computes the page's oldest `startLocal` date and writes
      `store.putMeta({ ...workingMeta, backfill: { done: false, endDate } })`. On
      `result.ok && result.complete` it sets
      `backfill: { done: true, completedAt: new Date().toISOString() }`.
    - **Incremental:** `startDate` = the newest stored run's `startLocal` minus 3 days
      (via `shiftDateKey`), then `garmin.fetchRuns({ startDate, maxPages: MAX_PAGES_PER_SYNC, onPage: merge })`.
    - **Final meta:** `{ ...workingMeta, lastAttempt, lastStatus, lastTrigger, lastResult: { added, updated, pages, fetched }, storedRuns }`.
      On success it also sets `lastSync = finishedAt`, `lastError = null` and
      `blockedUntil = null`. On failure it sets `lastError = { at, status, message }`,
      and for `rate_limited` also `blockedUntil = now + retryAfterSeconds`.
    - It logs `'[sync] ' + trigger + ': ' + status + ', ' + added + ' new, ' + updated + ' updated, ' + size + ' stored'`
      (`console.log` on success, `console.warn` plus ` (message)` on failure).
    - It returns
      `{ status, trigger, at, added, updated, storedRuns, pages, message, backfillDone }`.
  - `async function runSync(garmin, store, trigger)`:
    1. If `meta.blockedUntil` is in the future → return a `status: 'rate_limited'` object.
    2. If `store.isLocked()` → return `status: 'busy'`.
    3. Otherwise `store.lock(at, LOCK_TTL_SECONDS)`, then `try performSync`, `catch` → write
       `{ ...latest, lastAttempt, lastStatus: 'error', lastError }` and return `status: 'error'`,
       and `finally store.unlock()`.
  - `export function garminSource({ store, garmin })` → `{ name: 'garmin', runs(), meta(), tokenExpiresAt(), sync(trigger) }`.
- `garmin.fetchRuns({ startDate, endDate, maxPages, onPage })` calls
  `onPage(records, { hasMore })` per page (`hasMore` = the page was full, so another page
  follows). It returns `{ ok, pages, fetched, complete }` or a failure
  `{ ok: false, reason, message, pages, fetched, complete: false }`, and never throws on HTTP errors.
- `src/sample.js` — `sampleSource({ now, timezone, shiftToToday })`. Its `sync(trigger)`
  returns `{ status: 'sample', trigger, at, added: 0, updated: 0 }`. Its `meta()` returns
  `{ lastStatus: 'sample', backfill: { done: true }, storedRuns: runs.length }`.
- `src/index.js`:
  - `buildStatus(source, now)` reads `source.meta()` and `source.tokenExpiresAt()`
  - `buildStats(source, now)` reads `source.runs()` plus `buildStatus`
  - `POST /api/refresh` does `const sync = await source.sync('manual'); return json({ sync, stats: await buildStats(source, new Date()) });`
  - `scheduled` does `ctx.waitUntil(runSource(env, new Date()).sync('cron'))`
- Tests: `test/helpers/fake-kv.js` (`createFakeKv()` → `{ data, writes, get, put, delete }`);
  `kvStore` in `src/store.js` (`getRuns`, `putRuns`, `getMeta`, `putMeta`, `isLocked`,
  `lock`, `unlock`, `getToken`, `putToken`, `deleteToken`). Pattern file: `test/garmin.test.js`.
- Conventions: **no comments in code**, constants at the top, two-space indent, single
  quotes, semicolons.

## Commands you will need

| Purpose | Command (from `running-dashboard/`) | Expected on success |
|---|---|---|
| Tests | `npm test` | exit 0, `# fail 0` |
| One file | `node --test test/sync.test.js` | exit 0 |
| Syntax | `node --check src/sync.js` | exit 0 |
| Dev server | `npx wrangler dev` (second terminal) | `Ready on http://localhost:8787` |

## Scope

**In scope:**
- `src/sync.js` (rewrite to the target in Step 1)
- `src/sample.js` (change `sync()` to the new return shape)
- `src/index.js` (refresh uses the returned state)
- `test/sync.test.js` (create)
- `CLAUDE.md` (the `src/sync.js` bullet and the `npm test` comment, if the file exists)

**Out of scope** (do NOT touch):
- `src/garmin.js`, `src/store.js`, `src/stats.js`, `public/**`, `src/config.js`.
- The JSON shape of `/api/stats`, `/api/status` and the `sync` object in the `/api/refresh` response. The page depends on them.
- Lock semantics. KV has no atomic compare-and-set, so the lock stays best-effort;
  merging by id makes a rare double sync harmless.
- Mirroring deletions from Garmin. It's a known gap of incremental syncing and is not in this plan.

## Git workflow

Not a git repository. If the owner has run `git init` since, use branch
`advisor/005-sync-core` and commit after Steps 2 and 4 (e.g. `Extract pure sync core`).
Otherwise edit in place and list the changed files in your report.

## Steps

### Step 1: Rewrite `src/sync.js` to this exact content

```js
import { shiftDateKey } from './stats.js';

const LOCK_TTL_SECONDS = 300;
const MAX_PAGES_PER_SYNC = 40;
const INCREMENTAL_OVERLAP_DAYS = 3;
const CHECKPOINT_EVERY_PAGES = 5;
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
  if (!(meta.backfill && meta.backfill.done)) {
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
```

Notes on intended behaviour changes (all deliberate, all tested in Step 2):
- `activities` and backfill `meta` are written every 5 pages, and only when another page
  follows, plus once at the end. Before, both were written after every page.
- `sync()` returns `{ result, runs, meta }`. `result` is exactly the old sync object.
- `completedAt` now equals the final `lastAttempt` timestamp (the same `nowMs`) instead
  of a separate `new Date()` taken a few milliseconds earlier.

**Verify**: `node --check src/sync.js` → exit 0; `grep -c "new Date()" src/sync.js` → `0`; `grep -c "Date.now()" src/sync.js` → `0`

### Step 2: Write `test/sync.test.js`

Use `node:test`, `node:assert/strict`, `kvStore` (`../src/store.js`), `createFakeKv`
(`./helpers/fake-kv.js`), and from `../src/sync.js`: `mergeRuns`, `planFetch`,
`statusOf`, `nextBackfill`, `nextMeta` and `syncRuns`.

Helpers in the test file:
- `run(id, startLocal, extra = {})` → `{ id, name: 'R' + id, type: 'running', startLocal, distance: 5000, duration: 1800, elevationGain: 10, ...extra }`
- `NOW = Date.UTC(2026, 10, 21, 12)`, `now = () => NOW`
- `fakeGarmin(pages, finalResult)`. `pages` is an array of record arrays. Its
  `fetchRuns(args)`:
  - stores `args` in `fakeGarmin.calls`
  - calls `await args.onPage(pages[i], { hasMore: i < pages.length - 1 || finalResult.forceMore })` for each page, in order
  - then returns `finalResult.ok === false ? { ...finalResult, pages: pages.length, fetched: count } : { ok: true, pages: pages.length, fetched: count, complete: finalResult.complete !== false }`

  It also has `tokenInfo: async () => null`.
- `writesFor(kv, key)` → `kv.writes.filter((w) => w.key === key).length`

Pure-function cases:
1. **`mergeRuns`**: stored `[a, b]`, incoming `[b (identical), a' (changed distance), c (new)]`
   → `added 1, updated 1, changed true`, and `runs` sorted newest-first by `startLocal`.
   Identical incoming → `changed false`.
2. **`planFetch`**:
   - `{}` → `{ mode: 'backfill', endDate: null }`
   - `{ backfill: { done: false, endDate: '2025-01-10' } }` → `endDate '2025-01-10'`
   - `{ backfill: { done: true } }` with runs whose newest is `'2026-11-19 18:20:15'` → `{ mode: 'incremental', startDate: '2026-11-16' }`
   - done with `[]` → `startDate: null`
3. **`statusOf`**:
   - `{ ok: true, complete: true }` → `'ok'`; `{ ok: true, complete: false }` → `'partial'`
   - reasons `key_invalid`, `rate_limited` and `not_configured` map to themselves
   - `network` → `'network_error'`; `http_error` → `'error'`
4. **`nextBackfill`**:
   - incremental plan returns `meta.backfill` unchanged
   - backfill with `{ ok: true, complete: true }` → `{ done: true, completedAt: new Date(NOW).toISOString() }`
   - a failed backfill with cursor `'2024-05-01'` → `{ done: false, endDate: '2024-05-01' }`
   - failed with no cursor → the previous `meta.backfill`
5. **`nextMeta` success**: start from `{ lastError: { message: 'old' }, blockedUntil: 'x' }`.
   Expect `lastError === null`, `blockedUntil === null`, `lastSync === lastAttempt === new Date(NOW).toISOString()`, and the right `lastResult` and `storedRuns`.
6. **`nextMeta` rate-limited**: `result = { ok: false, reason: 'rate_limited', retryAfterSeconds: 120, message: 'm', pages: 1, fetched: 100 }`
   → `lastStatus 'rate_limited'`, `blockedUntil === new Date(NOW + 120000).toISOString()`,
   `lastError.message === 'm'`, and `lastSync` unchanged from the input meta.

`syncRuns` cases, each with `store = kvStore(kv = createFakeKv())`:

7. **Fresh backfill, 12 full pages, complete.** Use 12 pages of 3 runs each, with dates
   descending across pages.
   - `result.status === 'ok'`, `result.added === 36`, `result.backfillDone === true`
   - `writesFor(kv, 'activities') === 3` (checkpoints after pages 5 and 10, plus the final write)
   - `writesFor(kv, 'meta') === 3`
   - the stored meta has `backfill.done === true` and `storedRuns === 36`
   - the returned `runs.length === 36` and deep-equals `await store.getRuns()`
8. **Backfill interrupted by a 429 after 7 pages.**
   `finalResult = { ok: false, reason: 'rate_limited', retryAfterSeconds: 60, message: 'Garmin rate limit reached', forceMore: true }`.
   - `result.status === 'rate_limited'`
   - the stored meta has `backfill: { done: false, endDate: <oldest date of page 7> }` and `blockedUntil === new Date(NOW + 60000).toISOString()`
   - all 21 runs are stored
9. **The next run while blocked.** Pre-store meta
   `{ blockedUntil: new Date(NOW + 60000).toISOString() }`. `syncRuns` returns
   `result.status 'rate_limited'`, and the fake's `fetchRuns` was never called.
10. **Resume.** Pre-store meta `{ backfill: { done: false, endDate: '2024-05-01' } }`. The
    fake receives `args.endDate === '2024-05-01'` and no `startDate`.
11. **Incremental with overlap.** Pre-store meta `{ backfill: { done: true } }` and runs
    `[run(1,'2026-11-19 08:00:00'), run(2,'2026-11-17 08:00:00')]`.
    - The fake receives `startDate === '2026-11-16'`.
    - Its page `[run(2, '2026-11-17 08:00:00', { distance: 6000 }), run(3, '2026-11-20 07:00:00')]` gives `added 1, updated 1`, and 3 runs stored.
12. **Busy.** `await store.lock('other', 300)` first → `result.status === 'busy'`, `fetchRuns` not called, and the lock still present.
13. **Unexpected error.** The fake's `fetchRuns` throws `new Error('boom')`.
    - `result.status === 'error'` and `result.message` includes `'boom'`
    - the stored meta has `lastStatus: 'error'`
    - `await store.isLocked() === false` (the lock was released)
14. **A key failure leaves stored runs untouched.** Pre-store 2 runs and
    `{ backfill: { done: true } }`. The fake returns
    `{ ok: false, reason: 'key_invalid', message: 'Garmin key invalid or expired' }` with zero pages.
    - `result.status === 'key_invalid'`
    - still exactly 2 stored runs, and `writesFor(kv, 'activities') === 1` (only the pre-store write)

**Verify**: `node --test test/sync.test.js` → exit 0, `# pass 14`

### Step 3: Adapt `src/sample.js`

Inside `sampleSource`, hoist the meta into a constant and return the new shape from
`sync`:

```js
export function sampleSource({ now, timezone, shiftToToday }) {
  const runs = shiftedRuns(now, timezone, shiftToToday);
  const meta = { lastStatus: 'sample', backfill: { done: true }, storedRuns: runs.length };
  return {
    name: 'sample',
    async runs() {
      return runs;
    },
    async meta() {
      return meta;
    },
    async tokenExpiresAt() {
      return null;
    },
    async sync(trigger) {
      console.log('[sync] ' + trigger + ': sample mode, Garmin not called');
      return { result: { status: 'sample', trigger, at: now.toISOString(), added: 0, updated: 0 }, runs, meta };
    },
  };
}
```

Leave `shiftedRuns` and the imports unchanged.

**Verify**: `node --check src/sample.js` → exit 0

### Step 4: Use the returned state in `src/index.js`

Split the status and stats builders into pure "from" functions and thin readers. Keep
`buildStatus` and `buildStats` for the GET routes:

```js
function statusFrom(source, meta, tokenExpiresAt, now) {
  return {
    source: source.name,
    lastSync: meta.lastSync || null,
    lastAttempt: meta.lastAttempt || null,
    lastStatus: meta.lastStatus || 'never_synced',
    lastError: meta.lastError || null,
    lastResult: meta.lastResult || null,
    storedRuns: meta.storedRuns || 0,
    backfillDone: Boolean(meta.backfill && meta.backfill.done),
    blockedUntil: meta.blockedUntil || null,
    keyConfigured: isKeyConfigured(GARMIN_API_KEY),
    keyExpiry: keyExpiryInfo(GARMIN_KEY_EXPIRES, { now, timezone: TIMEZONE }),
    tokenExpiresAt,
  };
}

async function buildStatus(source, now) {
  const [meta, tokenExpiresAt] = await Promise.all([source.meta(), source.tokenExpiresAt()]);
  return statusFrom(source, meta, tokenExpiresAt, now);
}

function statsFrom(runs, status, now) {
  const stats = computeStats(runs, {
    now,
    timezone: TIMEZONE,
    weekStartDay: WEEK_START_DAY,
    goalSeconds: GOAL_MARATHON_SECONDS,
    race: { name: RACE_NAME, date: RACE_DATE, place: RACE_PLACE },
  });
  return { ...stats, locale: LOCALE, status };
}

async function buildStats(source, now) {
  const [runs, status] = await Promise.all([source.runs(), buildStatus(source, now)]);
  return statsFrom(runs, status, now);
}
```

The refresh route becomes:

```js
  if (route === 'POST /api/refresh') {
    const { result, runs, meta } = await source.sync('manual');
    const after = new Date();
    const status = statusFrom(source, meta, await source.tokenExpiresAt(), after);
    return json({ sync: result, stats: statsFrom(runs, status, after) });
  }
```

The `scheduled` handler stays `ctx.waitUntil(runSource(env, new Date()).sync('cron'));`
(the returned object is ignored there).

**Verify**:
- `node --check src/index.js` → exit 0
- `grep -c "buildStats(source, new Date())" src/index.js` → `0`

### Step 5: Full run and smoke test

1. `npm test` → exit 0, `# fail 0` (all earlier tests plus 14 new).
2. `npx wrangler dev`, with `USE_SAMPLE_DATA = true` in `src/config.js` (check with
   `grep -c "USE_SAMPLE_DATA = true" src/config.js` → `1`; do not print the file).
3. `curl -s -X POST http://localhost:8787/api/refresh` →
   - the JSON has a top-level `"sync"` with `"status": "sample"`
   - `"stats"` contains `"thisWeek"` and `"status"`
   - there is **no** top-level `"result"` key (the response shape is unchanged)
4. `curl -s http://localhost:8787/api/status` → `"source": "sample"`.
5. `curl -s "http://localhost:8787/__scheduled"` → `Ran scheduled event`, and the server
   log shows `[sync] cron: sample mode, Garmin not called`. This requires
   `npx wrangler dev --test-scheduled`; restart with that flag if needed.
6. If `CLAUDE.md` exists, change the `src/sync.js` bullet to:
   "`src/sync.js`: pure sync core (`mergeRuns`, `planFetch`, `nextBackfill`,
   `nextMeta`, `statusOf`) plus `syncRuns({ store, garmin, trigger, now })`, which handles
   the rate-limit block, KV lock and checkpointed writes every 5 pages. `garminSource`
   returns `{ result, runs, meta }` from `sync()`." Also extend the `npm test` comment to
   `# node --test: stats, store, garmin, sync (no network)`.

### Step 6 (owner only): one real sync

The owner, not the executor, temporarily sets `USE_SAMPLE_DATA = false`, runs
`curl.exe -X POST http://localhost:8787/api/refresh`, and checks for `"status": "ok"`
with unchanged run totals, then sets it back to `true`.

## Test plan

- `test/sync.test.js`: 14 cases (6 pure-function groups, 8 `syncRuns` scenarios) as listed in Step 2.
- Pattern: `test/garmin.test.js` and `test/store.test.js`.
- No network, no real timers, no `src/config.js`. Time is fixed via `now`.

## Done criteria

- [ ] `npm test` exits 0, `# fail 0`; `test/sync.test.js` has 14 passing tests
- [ ] `grep -c "new Date()\|Date.now()" src/sync.js` → `0`
- [ ] `grep -n "export function mergeRuns\|export function planFetch\|export function nextMeta\|export function nextBackfill\|export function statusOf\|export async function syncRuns" src/sync.js` → 6 matches
- [ ] Smoke test in Step 5: refresh response still has a top-level `sync` and `stats`, and no `result`
- [ ] Only in-scope files changed
- [ ] `plans/README.md` status row updated (note that Step 6 awaits the owner)

## STOP conditions

- The post-004 state checks in the drift check fail, or plan 004 is not DONE.
- Any pre-existing test (plans 003 and 004) fails after your change.
- Case 7 cannot reach exactly 3 `activities` writes without changing `garmin.fetchRuns`.
  The `hasMore` contract may differ from this plan; report it.
- Keeping the refresh response shape seems to require changing `public/app.js`.
- You need to open or print `src/config.js`, or to run a real Garmin sync.

## Maintenance notes

- **Checkpoints trade write volume for redo.** A crash mid-backfill refetches at most 4
  pages, and deduplication by id absorbs the overlap. If `PAGE_DELAY_MS` in
  `src/garmin.js` drops below 1000, re-check the one-write-per-second-per-key KV limit.
- **Deletions on Garmin are not mirrored.** Incremental sync only adds and updates. If
  that matters later, add a periodic full re-list that diffs by id. It belongs in
  `syncRuns` as its own mode, not as a special case inside `onPage`.
- **Review focus:** `nextBackfill` (resume correctness), and the condition in `onPage`
  that only checkpoints when `hasMore` is true.
- **Deferred:** a shared status vocabulary between `sync.js` and `public/app.js` was
  considered and left out. The audit found no status without a matching banner, so the
  duplication is cosmetic for now.
