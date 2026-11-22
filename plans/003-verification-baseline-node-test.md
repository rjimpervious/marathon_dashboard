# Plan 003: Establish a one-command test baseline with node:test

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: this folder is not a git repository. From
> `running-dashboard/`, run `sha256sum src/stats.js src/store.js package.json`
> and compare:
>
> ```
> 45f45b83320c00876ca5ed222d23bd4673d5e011ce7fda2ab76f90e73ffd9f43  src/stats.js
> a57091286c1cef920088cd183a167cab40c5cd7533ee5464756478eaecf5c6d0  src/store.js
> 1cb24bd29b98c7ddb1695f45e681363a095d3c3303670cea74b39afcc2a34c00  package.json
> ```
>
> On a mismatch, compare the "Current state" excerpts with the live files; if they
> no longer match, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (adds tests and one npm script; no runtime code changes)
- **Depends on**: none (002 recommended first)
- **Category**: tests
- **Planned at**: no git repository (file fingerprints above), 2026-11-21

## Why this matters

The project has no tests and no `npm test`. The only checks are `node --check` and
clicking around in `wrangler dev`. Plans 004 and 005 restructure the Garmin client and
the sync logic. Without a baseline they cannot prove they kept behaviour. This plan:

- adds `npm test` using Node's built-in test runner (no new dependencies, no build step)
- pins today's statistics output as **characterization tests**, so a later refactor that
  changes a number fails loudly
- provides a Map-backed fake of the Workers KV namespace, which plans 004 and 005 reuse

## Current state

- Node v26 is installed. `package.json`:

  ```json
  {
    "name": "running-dashboard",
    "version": "1.0.0",
    "private": true,
    "type": "module",
    "scripts": {
      "dev": "wrangler dev",
      "dev:scheduled": "wrangler dev --test-scheduled",
      "probe": "node scripts/probe.js",
      "deploy": "wrangler deploy"
    },
    "devDependencies": {
      "wrangler": "^4.0.0"
    }
  }
  ```

- `src/stats.js` — pure functions with **no imports** (safe to test in Node). Exports
  used here: `computeStats`, `calendarCountdown`, `isoWeekOf`, `keyExpiryInfo`,
  `parseEuropeanDate`, `localDateKey`, `shiftDateKey`, `riegelMarathonSeconds`.
  The signature is
  `computeStats(activities, { now, timezone, weekStartDay, goalSeconds, race })`
  (`src/stats.js:227`).
- `src/store.js` — `kvStore(kv)` wraps a KV namespace with `getRuns`, `putRuns`,
  `getMeta`, `putMeta`, `isLocked`, `lock(holder, ttlSeconds)` and `unlock`. Keys:
  `activities`, `meta`, `sync_lock`. It calls `kv.get(key, 'json')`,
  `kv.put(key, string, options)` and `kv.delete(key)`.
- `seed/sample-activities.json` — 40 fake runs in the stored record shape
  `{ id, name, type, startLocal: "YYYY-MM-DD HH:mm:ss", distance (m), duration (s),
  elevationGain, averageHR? }`. The newest run is on 2026-11-19.
- **Do not import these in tests**, because they cannot load in plain Node:
  - `src/garmin.js`, `src/index.js`, `src/sync.js` import `src/config.js`, which is
    gitignored and holds a secret (plan 004 removes that dependency).
  - `src/sample.js` imports JSON without an import attribute, which works in Wrangler's
    bundler but not in Node.
- Code style the owner requires: **no comments in code**, ES modules, two-space indent,
  single quotes, semicolons. Exemplar: `src/store.js`.

### Characterization values (computed from the current code when this plan was written)

Input: the seed file unchanged, `now = new Date('2026-11-21T12:00:00Z')`,
`timezone 'Europe/Berlin'`, `weekStartDay 1`, `goalSeconds 14400`, race
`{ name: 'Linz Marathon 2027', date: '11.04.2027', place: 'Linz, Austria' }`:

| Field | Value |
|---|---|
| `today` / `isoWeek` | `'21.11.2026'` / `47` |
| `goal` | `{ seconds: 14400, paceSecPerKm: 341 }` |
| `thisWeek` from / to / runs / distanceKm / trailRuns | `'16.11.2026'` / `'22.11.2026'` / `2` / `17.6` / `1` |
| `thisWeek.days` weekday:km, today marked | Mon 0, Tue 8.2, Wed 0, Thu 9.4, Fri 0, **Sat (isToday)** 0, Sun 0 |
| `month` label / runs / distanceKm / trailKm | `'November 2026'` / `7` / `93.5` / `27.3` |
| `year` runs / distanceKm / trailKm | `40` / `465.9` / `73.6` |
| `weekly.length`, last entry | `16`; `{ weekStart: '16.11.2026', runs: 2, distanceKm: 17.6, avgPaceSecPerKm: 416 }` |
| `longestRun8w` | `{ date: '07.11.2026', distanceKm: 24.3, durationSeconds: 9291 }` |
| `pace` | `{ windowWeeks: 8, avgSecPerKm: 389, vsGoalSecPerKm: 48 }` |
| `projection` | `seconds 14629, paceSecPerKm 347, gapSeconds 229, paceVsGoalSecPerKm 6, basis.date '29.10.2026', basis.distanceKm 10, longestRun6w.distanceKm 24.3, optimistic true` |
| `race` | `{ phase: 'upcoming', totalDays: 141, months: 4, days: 21, weeks: 20, weekday: 'Sun', date: '11.04.2027' }` |
| `totals` | `{ storedRuns: 40, firstRunDate: '04.08.2026', lastRunDate: '19.11.2026' }` |

Other verified values:
- `calendarCountdown(Date.UTC(2027,0,31), Date.UTC(2027,2,1))` → `{ totalDays: 29, months: 1, days: 1, weeks: 4 }`
- `isoWeekOf(Date.UTC(2027,0,1))` → `53`; `isoWeekOf(Date.UTC(2025,11,29))` → `1`
- `keyExpiryInfo('05.12.2026', { now: 2026-11-21T12:00Z, timezone: 'Europe/Berlin' })` → `daysLeft 14, warn true, expired false`
- `keyExpiryInfo('')` → `{ configured: false }`; `keyExpiryInfo('31.02.2027', …)` → `{ configured: true, valid: false, raw: '31.02.2027' }`
- `localDateKey(new Date('2026-11-21T23:30:00Z'), 'Europe/Berlin')` → `'2026-11-22'`
- `Math.round(riegelMarathonSeconds(3180, 10000))` → `14629`
- `shiftDateKey('2026-03-01', -3)` → `'2026-02-26'`

## Commands you will need

| Purpose | Command (from `running-dashboard/`) | Expected on success |
|---|---|---|
| Run tests | `npm test` | exit 0, summary shows `# fail 0` |
| One file | `node --test test/stats.test.js` | exit 0 |
| Syntax | `node --check <file>` | exit 0 |

## Scope

**In scope:**
- `package.json` — add one script
- `test/helpers/fake-kv.js` (create)
- `test/stats.test.js` (create)
- `test/store.test.js` (create)
- `CLAUDE.md` — one line in the Commands block, only if the file exists (created by plan 002)

**Out of scope** (do NOT touch):
- Any file in `src/` or `public/`. This plan must not change runtime code. If a test
  fails against current code, the test is wrong (or see STOP conditions).
- Tests for `garmin.js`, `sync.js`, `index.js` and `sample.js`. They can't load in Node
  yet; plans 004 and 005 add them.
- Adding any npm dependency (no Jest, Vitest or c8).

## Git workflow

Not a git repository. If the owner has run `git init` since, use branch
`advisor/003-test-baseline` with commit message `Add node:test baseline`. Otherwise edit
in place and list the changed files in your report.

## Steps

### Step 1: Add the test script

In `package.json`, add `"test": "node --test"` to `scripts`, after `"probe"`. Keep
two-space JSON indentation.

**Verify**: `node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).scripts.test)"` → `node --test`

### Step 2: Create `test/helpers/fake-kv.js`

```js
export function createFakeKv() {
  const data = new Map();
  const writes = [];
  return {
    data,
    writes,
    async get(key, type) {
      if (!data.has(key)) return null;
      const value = data.get(key).value;
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value, options = {}) {
      writes.push({ key, options });
      data.set(key, { value: String(value), options });
    },
    async delete(key) {
      data.delete(key);
    },
  };
}
```

`node --test` treats files under `test/helpers/` with no tests as passing, so no
configuration is needed.

**Verify**: `node --check test/helpers/fake-kv.js` → exit 0

### Step 3: Create `test/store.test.js`

Use `node:test` (`describe`, `it`) and `node:assert/strict`. Cases:
1. `getRuns()` on an empty KV returns `[]`. `getMeta()` returns `{}`.
2. `putRuns([{ id: 1 }])` then `getRuns()` deep-equals `[{ id: 1 }]`. The raw stored value under key `activities` is the JSON string.
3. `putMeta({ lastStatus: 'ok' })` round-trips under key `meta`.
4. `isLocked()` is `false`. After `lock('holder', 300)` it is `true`, and the recorded write for `sync_lock` has `options.expirationTtl === 300`. After `unlock()` it is `false`.

Pattern:

```js
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
});
```

**Verify**: `node --test test/store.test.js` → exit 0, `# pass 4`

### Step 4: Create `test/stats.test.js`

Load the seed with
`JSON.parse(readFileSync(new URL('../seed/sample-activities.json', import.meta.url), 'utf8'))`
(`import { readFileSync } from 'node:fs'`). Build one `stats` object with the inputs from
"Characterization values" in a `before()` hook or at module level, then write one `it`
per table row. Assert exact values with `assert.equal` / `assert.deepEqual`. For
`thisWeek.days`, assert the array of `distanceKm` values `[0, 8.2, 0, 9.4, 0, 0, 0]`,
the weekdays `['Mon','Tue','Wed','Thu','Fri','Sat','Sun']`, and that only index 5 has
`isToday === true`.

Also add a `describe` for each helper with every value from "Other verified values":
- `calendarCountdown`: the month-end clamp case; same-day `{ totalDays: 0 }`; past date `totalDays < 0` with months, days and weeks all `0`.
- `isoWeekOf`: the year-boundary cases (`53` and `1`) and `isoWeekOf(Date.UTC(2026,10,21)) === 47`.
- `keyExpiryInfo`: warn at 14 days, empty string, invalid date, and an expired date (`'01.11.2026'` → `expired: true, warn: false`).
- `computeStats` race handling: `race: null` → `race === null`; `race.date ''` → `null`; `race.date '21.11.2026'` → `phase 'race_day'`; `'01.11.2026'` → `phase 'finished'`.
- `computeStats([], …)`: `thisWeek.runs === 0`, `projection.seconds === null`, `projection.optimistic === true`, `longestRun8w === null`, `pace.avgSecPerKm === null`, `pace.vsGoalSecPerKm === null`.
- `localDateKey` late-UTC case, `riegelMarathonSeconds`, `shiftDateKey`.

**Verify**: `node --test test/stats.test.js` → exit 0, `# fail 0`, at least 20 passing tests

### Step 5: Run everything and update CLAUDE.md

Run `npm test`. If `CLAUDE.md` exists, change the line
`npm test                            # node --test (only once package.json has a test script)`
to
`npm test                            # node --test: stats, store (pure, no network)`.

**Verify**: `npm test` → exit 0, `# fail 0`. If `CLAUDE.md` exists,
`grep -c "stats, store (pure, no network)" CLAUDE.md` → `1`.

## Test plan

This plan *is* the test plan:
- `test/store.test.js`: 4 tests
- `test/stats.test.js`: about 25 tests, pinned to today's verified output

They don't use the network, real timers or `src/config.js`. All dates are fixed via
`now`.

## Done criteria

- [ ] `npm test` exits 0 with `# fail 0` and at least 24 passing tests
- [ ] `grep -rn "config.js" test/` → no matches
- [ ] `sha256sum src/stats.js src/store.js` unchanged from the drift-check values
- [ ] Only `package.json`, `test/**` and (optionally) `CLAUDE.md` changed
- [ ] `plans/README.md` status row updated

## STOP conditions

- A characterization assertion fails against the **unchanged** code. Do not change
  `src/` to make it pass, and do not silently change the expected value. Report the
  field, the expected value and the actual value. The code may have drifted since this
  plan was written.
- `node --test` is not available (Node older than 18).
- A test needs to import `src/config.js`, `src/garmin.js`, `src/sync.js`, `src/index.js` or `src/sample.js`.

## Maintenance notes

- These characterization values pin current behaviour, including the owner's spec
  choices: Riegel exponent 1.06, runs of at least 5 km in the last 8 weeks, 28 km
  confidence threshold. A deliberate formula change must update the expected values in
  the same change, with a note in the review.
- The seed file is test input now. Editing `seed/sample-activities.json` breaks these
  tests by design.
- Plans 004 and 005 add `test/garmin.test.js` and `test/sync.test.js` and reuse `test/helpers/fake-kv.js`.
