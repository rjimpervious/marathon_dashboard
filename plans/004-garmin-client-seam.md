# Plan 004: Give the Garmin client injectable dependencies and a straight page loop

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: this folder is not a git repository. From
> `running-dashboard/`, run
> `sha256sum src/garmin.js src/sync.js src/index.js src/store.js scripts/probe.js`
> and compare:
>
> ```
> 38706c005e5f029ff7673f6151e4891e87aa5087b51bedf9d5be083c99171215  src/garmin.js
> a86b53d7b2bd201dd46640dacfb9d3ce2e5ba0e986b88af5f2c3d483e75e713b  src/sync.js
> 6c38da665b49eb374b37255bf61439aa7e78104fa2c440761703f54ae8931e13  src/index.js
> a57091286c1cef920088cd183a167cab40c5cd7533ee5464756478eaecf5c6d0  src/store.js
> b549c08a843fb0b0397c2ff8c9ba79fb00784dc4e172f5e514185cc3eafcc5ee  scripts/probe.js
> ```
>
> On a mismatch, compare the "Current state" excerpts with the live files; if they
> no longer match, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (touches the live Garmin path; offline tests and a sample-mode smoke test cover it, and the owner runs one real sync at the end)
- **Depends on**: 003 (needs `npm test` and `test/helpers/fake-kv.js`)
- **Category**: tech-debt, tests
- **Planned at**: no git repository (file fingerprints above), 2026-11-21

## Why this matters

`src/garmin.js` holds the trickiest logic in the project: the token cache with a
10-minute reuse margin, JWT expiry decoding, clearing the token when the key is
rejected, and "on 401, get one new token and retry once". It reaches straight for its
dependencies:

- the global `fetch`
- a real 1-second `setTimeout` between pages
- `Date.now`
- `GARMIN_API_KEY` imported from the gitignored `src/config.js`
- `env.RUNS` for the token cache

None of it can be tested without the live API and real waits. The module also can't
even be imported in a test without the secret config file.

After this plan:
- `createGarminClient({ apiKey, tokenStore, fetch, sleep, now })` is the seam. The
  production adapter is the real fetch and KV; tests use a fake fetch, instant sleep and
  a Map-backed KV.
- Only `src/index.js` imports `src/config.js`.
- The page loop loses its `page--; continue;` retry trick and its six copied
  stop-objects.
- Callers receive run records only. The raw Garmin page no longer leaks to `src/sync.js`.
- `scripts/probe.js` reuses the Garmin endpoint constants instead of keeping copies.

## Current state

- `src/garmin.js` (197 lines):
  - line 1: `import { GARMIN_API_KEY } from './config.js';`
  - lines 3–16: constants (`API_BASE`, `TOKEN_URL`, `SEARCH_URL`, `TOKEN_KV_KEY = 'garmin_token'`, `TOKEN_REUSE_MARGIN_SECONDS = 600`, `FALLBACK_TOKEN_LIFETIME_SECONDS`, `MIN_KV_TTL_SECONDS = 60`, `PLACEHOLDER_KEY`, `RUNNING_PARENT_KEY`, `RUNNING_TYPE_ID = 1`, `PAGE_LIMIT = 100`, `PAGE_DELAY_MS = 1000`, `REQUEST_TIMEOUT_MS = 30000`, `DEFAULT_RETRY_AFTER_SECONDS = 900`)
  - line 18 `sleep`, line 59 `timedFetch` (uses global `fetch`)
  - line 76 `export function isKeyConfigured()` (no parameter, reads the import)
  - line 80 `export async function readCachedToken(env)`
  - line 84 `export async function getAccessToken(env, { forceNew })`
  - lines 121–139 `isRun`, `compact` (keep exactly as they are)
  - lines 141–197 `export async function fetchRuns(env, { startDate, endDate, maxPages, onPage })`. Excerpt of the retry and the repeated stop-object:

    ```js
    // src/garmin.js:168-178
        if ((res.status === 401 || res.status === 403) && !retriedAuth) {
          await res.text().catch(() => '');
          retriedAuth = true;
          tokenResult = await getAccessToken(env, { forceNew: true });
          if (!tokenResult.ok) return { ...tokenResult, pages, fetched, complete: false };
          page--;
          continue;
        }
        if (!res.ok) {
          await res.text().catch(() => '');
          return { ...failureFromResponse(res, 'Activity search'), pages, fetched, complete: false };
        }
    ```

    line 193: `await onPage(body.filter(isRun).map(compact), body);` (the second argument is the raw Garmin page)
- `src/sync.js`:
  - line 1 `import { fetchRuns, readCachedToken } from './garmin.js';`
  - line 2 `import { kvStore } from './store.js';`
  - lines 46–56, backfill call that reads a raw Garmin field:

    ```js
        result = await fetchRuns(env, {
          endDate: resumeEndDate,
          maxPages: MAX_PAGES_PER_SYNC,
          onPage: async (records, raw) => {
            await merge(records);
            const dates = raw.map((a) => String(a.startTimeLocal || '').slice(0, 10)).filter(Boolean).sort();
            if (dates.length) {
              workingMeta = { ...workingMeta, backfill: { done: false, endDate: dates[0] } };
              await store.putMeta(workingMeta);
            }
          },
        });
    ```
  - line 64: `result = await fetchRuns(env, { startDate, maxPages: MAX_PAGES_PER_SYNC, onPage: merge });`
  - `performSync(env, store, trigger, meta)` (line 19), `runSync(env, store, trigger)` (line 106)
  - lines 132–149: `export function garminSource(env)` builds `kvStore(env.RUNS)` and calls `readCachedToken(env)` in `tokenExpiresAt()`
- `src/index.js`:
  - line 1 `import { isKeyConfigured } from './garmin.js';`
  - lines 31–35 `runSource(env, now)` returns `sampleSource({...})` or `garminSource(env)`
  - line 49 `keyConfigured: isKeyConfigured(),`
  - it already imports from `./config.js` (lines 5–16) but not `GARMIN_API_KEY`
- `src/store.js` — `kvStore(kv)` with keys `activities`, `meta`, `sync_lock`. It has no token methods.
- `scripts/probe.js` — lines 6–8, 12, 14, 19 and 21 redefine `TOKEN_URL`, `API_BASE`,
  `SEARCH_PATH`, `RUNNING_PARENT_KEY`, `PAGE_LIMIT`, `REQUEST_TIMEOUT_MS` and
  `PLACEHOLDER_KEY` with the same values as `src/garmin.js`.
- Conventions (owner's rules): **no comments in code**, module-level constants at the
  top, two-space indent, single quotes, semicolons. Failures are returned as
  `{ ok: false, reason, message, ...extra }` via `failure()`, never thrown. Keep every
  existing `reason` string and message text unchanged: `src/sync.js` and the page depend
  on them.
- **Workers gotcha:** calling an unbound reference to the global `fetch` (for example
  `const f = globalThis.fetch; f(url)`) throws "Illegal invocation" in the Workers
  runtime. The default fetch must be a wrapper function that calls `fetch(...)` directly
  (see Step 2).

## Commands you will need

| Purpose | Command (from `running-dashboard/`) | Expected on success |
|---|---|---|
| Tests | `npm test` | exit 0, `# fail 0` |
| One file | `node --test test/garmin.test.js` | exit 0 |
| Syntax | `node --check src/garmin.js` | exit 0 |
| Dev server | `npx wrangler dev` (second terminal) | `Ready on http://localhost:8787` |
| Smoke | `curl -s http://localhost:8787/api/status` | JSON with `"keyConfigured": true` |

## Scope

**In scope:**
- `src/garmin.js` (rewrite to the target in Step 2)
- `src/store.js` (add token methods)
- `src/sync.js` (use the injected client; adapt `onPage`; no logic changes)
- `src/index.js` (build the client; `isKeyConfigured(GARMIN_API_KEY)`)
- `scripts/probe.js` (import endpoint constants; lines 1–21 only)
- `test/garmin.test.js` (create), `test/store.test.js` (add token cases)
- `CLAUDE.md` (update the `garmin.js` line, if the file exists)

**Out of scope** (do NOT touch):
- `src/config.js`. Never open or print it.
- The sync logic itself: merging, meta transitions, lock and rate-limit block. Plan 005 restructures it.
- `src/stats.js`, `src/sample.js`, `public/**`.
- Any change to failure `reason` strings, messages, `PAGE_LIMIT`, `PAGE_DELAY_MS` or the
  KV key `garmin_token`. Keeping the key name means the token already cached in KV keeps
  working.

## Git workflow

Not a git repository. If the owner has run `git init` since, use branch
`advisor/004-garmin-seam` and commit after Steps 3, 5 and 7 with imperative messages
(e.g. `Inject dependencies into the Garmin client`). Otherwise edit in place and list
the changed files in your report.

## Steps

### Step 1: Add token methods to `src/store.js`

Add a constant `const TOKEN_KEY = 'garmin_token';` next to the other keys, and three
methods inside the returned object, after `unlock()`:

```js
    async getToken() {
      return (await kv.get(TOKEN_KEY, 'json')) || null;
    },
    putToken(record, ttlSeconds) {
      return kv.put(TOKEN_KEY, JSON.stringify(record), { expirationTtl: ttlSeconds });
    },
    deleteToken() {
      return kv.delete(TOKEN_KEY);
    },
```

Add to `test/store.test.js`: `getToken()` is `null` initially. `putToken({ token: 't', expiresAt: 5 }, 120)` round-trips, and its write for key `garmin_token` has `options.expirationTtl === 120`. After `deleteToken()`, `getToken()` is `null`.

**Verify**: `node --test test/store.test.js` → exit 0, `# pass 7`

### Step 2: Rewrite `src/garmin.js` to this exact content

```js
const API_BASE = 'https://personal.connectapi.garmin.com';
const TOKEN_URL = API_BASE + '/personalapitoken-service/personal-api/personal-api-key/token';
const SEARCH_PATH = '/activitylist-service/activities/search/activities';
const TOKEN_REUSE_MARGIN_SECONDS = 600;
const FALLBACK_TOKEN_LIFETIME_SECONDS = 24 * 3600;
const MIN_TOKEN_TTL_SECONDS = 60;
const PLACEHOLDER_KEY = 'YOUR_GARMIN_API_KEY';
const RUNNING_PARENT_KEY = 'running';
const RUNNING_TYPE_ID = 1;
const PAGE_LIMIT = 100;
const PAGE_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_RETRY_AFTER_SECONDS = 900;

export const GARMIN_ENDPOINTS = Object.freeze({
  apiBase: API_BASE,
  tokenUrl: TOKEN_URL,
  searchPath: SEARCH_PATH,
  pageLimit: PAGE_LIMIT,
  runningParentKey: RUNNING_PARENT_KEY,
  placeholderKey: PLACEHOLDER_KEY,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
});

function defaultFetch(url, init) {
  return fetch(url, init);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err) {
  if (err && err.name === 'TimeoutError') return 'request timed out after ' + REQUEST_TIMEOUT_MS / 1000 + ' s';
  return err && err.message ? err.message : String(err);
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function failure(reason, message, extra = {}) {
  return { ok: false, reason, message, ...extra };
}

function parseRetryAfter(value, nowMs) {
  if (!value) return DEFAULT_RETRY_AFTER_SECONDS;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - nowMs) / 1000));
  return DEFAULT_RETRY_AFTER_SECONDS;
}

function failureFromResponse(res, context, nowMs) {
  if (res.status === 401 || res.status === 403) {
    return failure('key_invalid', 'Garmin key invalid or expired (' + context + ' returned HTTP ' + res.status + ')', {
      status: res.status,
    });
  }
  if (res.status === 429) {
    return failure('rate_limited', 'Garmin rate limit reached (' + context + ' returned HTTP 429)', {
      status: 429,
      retryAfterSeconds: parseRetryAfter(res.headers.get('Retry-After'), nowMs),
    });
  }
  return failure('http_error', context + ' returned HTTP ' + res.status, { status: res.status });
}

function decodeJwtExp(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

export function isKeyConfigured(apiKey) {
  return Boolean(apiKey) && apiKey !== PLACEHOLDER_KEY;
}

export function isRun(activity) {
  const type = activity && activity.activityType;
  if (!type) return false;
  return type.typeKey === RUNNING_PARENT_KEY || type.typeId === RUNNING_TYPE_ID || type.parentTypeId === RUNNING_TYPE_ID;
}

export function compact(activity) {
  const record = {
    id: activity.activityId,
    name: activity.activityName || '',
    type: activity.activityType.typeKey,
    startLocal: activity.startTimeLocal,
    distance: round1(activity.distance || 0),
    duration: round1(activity.duration || 0),
    elevationGain: activity.elevationGain === null || activity.elevationGain === undefined ? null : round1(activity.elevationGain),
  };
  if (activity.averageHR !== null && activity.averageHR !== undefined) record.averageHR = Math.round(activity.averageHR);
  return record;
}

export function createGarminClient({ apiKey, tokenStore, fetch: fetchImpl = defaultFetch, sleep = defaultSleep, now = Date.now }) {
  const timedFetch = (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

  async function getAccessToken({ forceNew = false } = {}) {
    const nowSeconds = Math.floor(now() / 1000);
    if (!forceNew) {
      const cached = await tokenStore.getToken();
      if (cached && cached.token && cached.expiresAt - TOKEN_REUSE_MARGIN_SECONDS > nowSeconds) {
        return { ok: true, token: cached.token, expiresAt: cached.expiresAt, fromCache: true };
      }
    }
    if (!isKeyConfigured(apiKey)) return failure('not_configured', 'GARMIN_API_KEY is not set in src/config.js');

    let res;
    try {
      res = await timedFetch(TOKEN_URL, {
        method: 'POST',
        headers: { Authorization: 'ApiKey ' + apiKey, Accept: '*/*' },
      });
    } catch (err) {
      return failure('network', 'Token request failed: ' + errorMessage(err));
    }
    if (!res.ok) {
      await res.text().catch(() => '');
      const result = failureFromResponse(res, 'Token endpoint', now());
      if (result.reason === 'key_invalid') await tokenStore.deleteToken();
      return result;
    }

    const token = (await res.text()).trim();
    if (!token || /\s/.test(token)) return failure('bad_response', 'Token endpoint returned an unexpected body');
    const expiresAt = decodeJwtExp(token) || nowSeconds + FALLBACK_TOKEN_LIFETIME_SECONDS;
    await tokenStore.putToken(
      { token, expiresAt, obtainedAt: new Date(now()).toISOString() },
      Math.max(MIN_TOKEN_TTL_SECONDS, expiresAt - nowSeconds),
    );
    return { ok: true, token, expiresAt, fromCache: false };
  }

  async function searchPage(token, start, { startDate, endDate }) {
    const params = new URLSearchParams({
      activityType: RUNNING_PARENT_KEY,
      start: String(start),
      limit: String(PAGE_LIMIT),
      sortOrder: 'desc',
    });
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    try {
      const res = await timedFetch(API_BASE + SEARCH_PATH + '?' + params.toString(), {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      });
      return { res };
    } catch (err) {
      return { error: failure('network', 'Activity request failed: ' + errorMessage(err)) };
    }
  }

  async function fetchPage(auth, start, range) {
    let attempt = await searchPage(auth.token, start, range);
    if (attempt.error) return attempt.error;
    if ((attempt.res.status === 401 || attempt.res.status === 403) && !auth.retried) {
      await attempt.res.text().catch(() => '');
      auth.retried = true;
      const fresh = await getAccessToken({ forceNew: true });
      if (!fresh.ok) return fresh;
      auth.token = fresh.token;
      attempt = await searchPage(auth.token, start, range);
      if (attempt.error) return attempt.error;
    }
    const res = attempt.res;
    if (!res.ok) {
      await res.text().catch(() => '');
      return failureFromResponse(res, 'Activity search', now());
    }
    let body;
    try {
      body = await res.json();
    } catch {
      return failure('bad_response', 'Activity search returned invalid JSON');
    }
    if (!Array.isArray(body)) return failure('bad_response', 'Activity search did not return a list');
    return { ok: true, body };
  }

  async function fetchRuns({ startDate = null, endDate = null, maxPages, onPage }) {
    const tokenResult = await getAccessToken();
    if (!tokenResult.ok) return { ...tokenResult, pages: 0, fetched: 0, complete: false };

    const auth = { token: tokenResult.token, retried: false };
    let pages = 0;
    let fetched = 0;
    const stop = (result) => ({ ...result, pages, fetched, complete: false });

    for (let page = 0; page < maxPages; page++) {
      if (page > 0) await sleep(PAGE_DELAY_MS);
      const result = await fetchPage(auth, page * PAGE_LIMIT, { startDate, endDate });
      if (!result.ok) return stop(result);
      pages++;
      fetched += result.body.length;
      const hasMore = result.body.length === PAGE_LIMIT;
      await onPage(result.body.filter(isRun).map(compact), { hasMore });
      if (!hasMore) return { ok: true, pages, fetched, complete: true };
    }
    return { ok: true, pages, fetched, complete: false };
  }

  async function tokenInfo() {
    const cached = await tokenStore.getToken();
    return cached && cached.expiresAt ? { expiresAt: cached.expiresAt } : null;
  }

  return {
    isConfigured: () => isKeyConfigured(apiKey),
    getAccessToken,
    fetchRuns,
    tokenInfo,
  };
}
```

What changed compared with today, and nothing else may change:
- The config import, `readCachedToken`, the `env` parameters and `TOKEN_KV_KEY` are gone.
  The token now goes through `tokenStore`.
- `isKeyConfigured` takes `apiKey`.
- The retry lives in `fetchPage`. `auth.retried` is shared across pages, so there's still
  only one forced refresh per `fetchRuns` call, as before.
- `onPage(records, { hasMore })` replaces `onPage(records, rawPage)`.
- `parseRetryAfter` uses the injected `now`.

**Verify**: `node --check src/garmin.js` → exit 0; `grep -c "config.js" src/garmin.js` → `0`; `grep -c "env\." src/garmin.js` → `0`

### Step 3: Write `test/garmin.test.js`

Use `node:test`, `node:assert/strict`, `kvStore` from `../src/store.js` and
`createFakeKv` from `./helpers/fake-kv.js`. Helpers to define in the test file:
- `jwtWithExp(exp)`: returns
  `'h.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.s'`
- `fakeFetch(handlers)`: records every `{ url, init }` call and returns responses in
  sequence from an array of functions. Build responses with the global `Response`, e.g.
  `new Response(text, { status: 200 })` or
  `new Response(JSON.stringify(list), { status: 200, headers: { 'Content-Type': 'application/json' } })`.
- `rawRun(id, startTimeLocal, typeKey = 'running')`: returns
  `{ activityId: id, activityName: 'Run ' + id, activityType: { typeKey, typeId: typeKey === 'running' ? 1 : 6, parentTypeId: typeKey === 'running' ? 17 : 1 }, startTimeLocal, distance: 10000.04, duration: 3000.06, elevationGain: 12.34, averageHR: 150.4 }`
- `NOW = Date.UTC(2026, 10, 21, 12)`, `now = () => NOW`, and
  `sleepCalls = []` with `sleep = async (ms) => { sleepCalls.push(ms); }`.

Cases (one `it` each):
1. **Token fetch and store**: apiKey `'test-key'`, token response `jwtWithExp(NOW/1000 + 86400)`.
   - `getAccessToken()` returns `{ ok: true, fromCache: false }`.
   - The recorded call is to `GARMIN_ENDPOINTS.tokenUrl` with method `POST`, `Authorization: 'ApiKey test-key'` and `Accept: '*/*'`.
   - The KV write for `garmin_token` has `options.expirationTtl === 86400`.
2. **Cache reuse**: pre-store `{ token: 'cached', expiresAt: NOW/1000 + 3600 }`.
   `getAccessToken()` returns `fromCache: true`, `token: 'cached'`, and makes zero fetch calls.
3. **Inside the 10-minute margin**: pre-store `expiresAt: NOW/1000 + 300`. `getAccessToken()` fetches a new token (one call).
4. **Not configured**: apiKey `'YOUR_GARMIN_API_KEY'` returns
   `{ ok: false, reason: 'not_configured' }` with zero fetch calls.
5. **Rejected key**: the token endpoint returns 401. Result `reason 'key_invalid'`, and
   the stored token is deleted (`getToken()` is `null` after pre-storing an expired one).
6. **Two pages**: page 1 has 100 `rawRun`s, page 2 has 37.
   - `fetchRuns({ maxPages: 40, onPage })` returns `{ ok: true, pages: 2, fetched: 137, complete: true }`.
   - `onPage` is called twice, with `hasMore` `true` then `false`.
   - The records are compacted (`distance 10000`, `duration 3000.1`, `elevationGain 12.3`, `averageHR 150`).
   - `sleepCalls` deep-equals `[1000]`.
   - The second search URL contains `start=100`, and both contain `activityType=running`, `limit=100` and `sortOrder=desc`.
7. **Date filters**: `fetchRuns({ startDate: '2026-11-01', endDate: '2026-11-20', maxPages: 1, onPage })`. The URL contains both parameters.
8. **401 on search, one retry**: responses go token → 401 → new token → page of 5.
   Result `ok` and `complete`, with exactly 4 fetch calls.
9. **401 twice**: responses go token → 401 → new token → 401. Result `reason 'key_invalid'`, `complete: false`.
10. **429**: responses go token → page of 100 → 429 with header `Retry-After: 120`.
    Result `{ reason: 'rate_limited', retryAfterSeconds: 120, pages: 1, fetched: 100, complete: false }`.
11. **Network error**: the search fetch throws `new Error('boom')`. Result
    `reason 'network'`, and the message includes `'Activity request failed: boom'`.
12. **maxPages reached**: `maxPages: 2`, both pages full (100 each). Result
    `{ ok: true, pages: 2, complete: false }`.
13. **`isRun` and `compact`**: `isRun(rawRun(1, '…', 'trail_running')) === true`.
    `isRun({ activityType: { typeKey: 'cycling', typeId: 2, parentTypeId: 17 } }) === false`.
    When `averageHR` is `null`, `compact` omits the field.

**Verify**: `node --test test/garmin.test.js` → exit 0, `# pass 13`, and finishes in well under 5 seconds (proof that there are no real 1-second waits)

### Step 4: Adapt `src/sync.js` (wiring only)

- Replace lines 1–2 with nothing. `src/sync.js` must import only `{ shiftDateKey }` from `./stats.js`.
- `performSync(env, store, trigger, meta)` becomes `performSync(garmin, store, trigger, meta)`.
  Replace both `fetchRuns(env, {` with `garmin.fetchRuns({`.
- In the backfill `onPage`, change the signature to `async (records) => {` and derive the cursor from records:
  `const dates = records.map((r) => String(r.startLocal || '').slice(0, 10)).filter(Boolean).sort();`
  Leave the rest of the block unchanged.
- `runSync(env, store, trigger)` becomes `runSync(garmin, store, trigger)`, and its call
  becomes `performSync(garmin, store, trigger, meta)`.
- Replace `garminSource(env)` with:

```js
export function garminSource({ store, garmin }) {
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
      return runSync(garmin, store, trigger);
    },
  };
}
```

**Verify**:
- `node --check src/sync.js` → exit 0
- `grep -c "env" src/sync.js` → `0`
- `grep -c "startTimeLocal" src/sync.js` → `0`

### Step 5: Wire it in `src/index.js`

- Line 1 becomes `import { createGarminClient, isKeyConfigured } from './garmin.js';`
- Add `import { kvStore } from './store.js';` after the `./stats.js` import.
- Add `GARMIN_API_KEY,` to the `./config.js` import list, keeping it alphabetical (first entry).
- `runSource` becomes:

```js
function runSource(env, now) {
  if (USE_SAMPLE_DATA) return sampleSource({ now, timezone: TIMEZONE, shiftToToday: SAMPLE_SHIFT_TO_TODAY });
  const store = kvStore(env.RUNS);
  return garminSource({ store, garmin: createGarminClient({ apiKey: GARMIN_API_KEY, tokenStore: store }) });
}
```

- Line 49 becomes `keyConfigured: isKeyConfigured(GARMIN_API_KEY),`.

**Verify**:
- `node --check src/index.js` → exit 0
- `grep -rln "config.js" src/ | grep -v config` → only `src/index.js`

### Step 6: Make `scripts/probe.js` reuse the constants

Add `import { GARMIN_ENDPOINTS } from '../src/garmin.js';` after line 4. Then change
only these constants:

```js
const TOKEN_URL = GARMIN_ENDPOINTS.tokenUrl;
const API_BASE = GARMIN_ENDPOINTS.apiBase;
const SEARCH_PATH = GARMIN_ENDPOINTS.searchPath;
const RUNNING_PARENT_KEY = GARMIN_ENDPOINTS.runningParentKey;
const PAGE_LIMIT = GARMIN_ENDPOINTS.pageLimit;
const REQUEST_TIMEOUT_MS = GARMIN_ENDPOINTS.requestTimeoutMs;
const PLACEHOLDER_KEY = GARMIN_ENDPOINTS.placeholderKey;
```

Keep every other line of `probe.js` unchanged. The probe deliberately sends its own extra
requests and saves raw responses.

**Verify**: `node --check scripts/probe.js` → exit 0. Do **not** run `npm run probe`: it
calls the real API with the owner's key.

### Step 7: Full test run and sample-mode smoke test

1. `npm test` → exit 0, `# fail 0` (plan 003's tests plus the 13 new and 3 new store tests).
2. Start `npx wrangler dev`. `src/config.js` must still have `USE_SAMPLE_DATA = true`; check with `grep -c "USE_SAMPLE_DATA = true" src/config.js` → `1`, which prints a count, not the key.
3. `curl -s http://localhost:8787/api/status` → contains `"source": "sample"` and `"keyConfigured": true`.
4. `curl -s -X POST http://localhost:8787/api/refresh` → contains `"status": "sample"`.
5. If `CLAUDE.md` exists, change its `src/garmin.js` bullet to:
   "`src/garmin.js`: `createGarminClient({ apiKey, tokenStore, fetch, sleep, now })` —
   Garmin token (cached via the store) and paginated activity search; returns
   `{ ok: false, reason, message }` instead of throwing; `compact()` is the only place
   that translates Garmin fields." Also add `garmin` to the `npm test` comment so it
   reads `# node --test: stats, store, garmin (no network)`.

### Step 8 (owner only): one real sync

The owner, not the executor, temporarily sets `USE_SAMPLE_DATA = false`, runs
`curl.exe -X POST http://localhost:8787/api/refresh`, and checks for `"status": "ok"`
(or `"partial"`), then sets it back to `true`. This proves the default `fetch` wrapper
works in the Workers runtime.

## Test plan

- `test/garmin.test.js`: the 13 cases in Step 3. No network, no real timers, no `src/config.js`.
- `test/store.test.js`: 3 more cases for the token methods.
- Pattern: follow `test/store.test.js` from plan 003 (`describe`/`it`, `assert/strict`, `createFakeKv`).

## Done criteria

- [ ] `npm test` exits 0 with `# fail 0`; `test/garmin.test.js` has 13 passing tests
- [ ] `grep -rln "config.js" src/ | grep -v "src/config"` → exactly `src/index.js`
- [ ] `grep -c "env\." src/garmin.js src/sync.js` → `0` for both
- [ ] `grep -c "page--" src/garmin.js` → `0`
- [ ] `grep -c "startTimeLocal" src/sync.js` → `0`
- [ ] Sample-mode smoke test (Step 7) passes
- [ ] Only in-scope files changed
- [ ] `plans/README.md` status row updated (note that Step 8 awaits the owner)

## STOP conditions

- The excerpts in "Current state" don't match the live files (drift).
- Any test from plan 003 starts failing. This plan must not change stats or store behaviour.
- In `wrangler dev`, `/api/status` or `/api/refresh` returns HTTP 500 or logs
  "Illegal invocation". The fetch wrapper is wrong; do not work around it by binding globals in other files.
- You find you need to open or print `src/config.js`, or to run the probe or a real sync.
- Making a test pass seems to require changing a `reason` string or message text.

## Maintenance notes

- `createGarminClient` is the only seam to Garmin. New endpoints (VO2max, HRV) belong in
  it, and must use `timedFetch` and the shared `failure()` shape.
- Moving the key to `wrangler secret put GARMIN_API_KEY` later is now a change in one
  file: in `src/index.js`, read `env.GARMIN_API_KEY` instead of the config import.
- Plan 005 uses the new `{ hasMore }` argument of `onPage` to decide when to checkpoint.
  Do not remove it.
- Review focus: the retry path in `fetchPage` (cases 8 and 9), and that `defaultFetch`
  stays a wrapper rather than becoming a bare reference.
