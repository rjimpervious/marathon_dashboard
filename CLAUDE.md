# CLAUDE.md

Guidance for agents working in this folder (`running-dashboard/`).

> The parent folder's `D:\test\CLAUDE.md` describes a different project (an Astro
> hiking site). It does **not** apply here. Ignore it.

## Project

A personal running dashboard as a Cloudflare Worker: plain JavaScript ES modules, no
framework, no build step. It syncs runs from the Garmin Connect Personal API into
Workers KV every 3 hours and serves a dashboard page. Metric units, dates as
`DD.MM.YYYY`, weeks start on Monday, time zone Europe/Berlin.

## Commands

```bash
npm install
npx wrangler dev                    # http://localhost:8787 (local KV is simulated)
npx wrangler dev --test-scheduled   # then: curl "http://localhost:8787/__scheduled"
npm run probe                       # one-off Garmin API probe (needs a real key)
npm test                            # node --test: stats, store, garmin, sync, gate (no network)
```

`wrangler.toml` has `[dev] host = "localhost"`. Without it, `wrangler dev` presents local
requests as coming from the custom domain `run.rjlopez.me`, and the secret-link gate
refuses them with 401.

There is no linter, formatter or typecheck. To check a change: `node --check <file>`
for syntax, `npm test` if it exists, then `npx wrangler dev` and
`curl -s http://localhost:8787/api/stats`.

## Architecture

- `src/index.js`: Worker entry. API routes `GET /api/stats`, `GET /api/status`, `GET /api/runs?ids=`
  (run details for `public/run.html`) and
  `POST /api/refresh`, plus the `scheduled` (cron) handler. It picks the run source once
  per request: the sample source when `USE_SAMPLE_DATA` is true, otherwise the Garmin
  source.
- `src/sync.js`: pure sync core (`mergeRuns`, `planFetch`, `nextBackfill`,
  `nextMeta`, `statusOf`) plus `syncRuns({ store, garmin, trigger, now })`, which handles
  the rate-limit block, KV lock and checkpointed writes every 5 pages. `garminSource`
  returns `{ result, runs, meta }` from `sync()`.
- `src/sample.js`: sample run source from `seed/sample-activities.json`. It never calls Garmin.
- `src/gate.js`: `evaluateGate(request, token)` — the secret-link check. A request needs
  the `rd_access` cookie (or the `?k=` link, which sets it). Skipped on localhost; on any
  other host it fails closed (503) when `ACCESS_TOKEN` is missing or shorter than 16
  characters. `src/index.js` runs it before everything else and serves the
  static page through `env.ASSETS` (`run_worker_first`).
- `src/store.js`: the only place that knows KV keys (`activities`, `meta`, `sync_lock`,
  `garmin_token`).
- `src/garmin.js`: `createGarminClient({ apiKey, tokenStore, fetch, sleep, now })` —
  Garmin token (cached via the store) and paginated activity search; returns
  `{ ok: false, reason, message }` instead of throwing; `compact()` is the only place
  that translates Garmin fields.
- `src/stats.js`: pure functions. `computeStats(runs, { now, timezone, weekStartDay,
  goalSeconds, race })` returns everything the page shows.
- `public/`: static pages (`index.html`, `run.html`, `calendar.html` with their `.js`, plus `app.css`, `format.js`) plus
  `_headers` (CSP without `'unsafe-inline'`). The Worker does not serve the page.

## Code style (owner's rules, strict)

- No comments in code.
- No CLI arguments. Settings are module-level constants at the top of the file.
- Secrets (`GARMIN_API_KEY`, `ACCESS_TOKEN`) live only in `.dev.vars` (gitignored,
  local) and as Wrangler secrets in production; the Worker reads them from `env`.
  `src/config.js` holds non-secret settings only and is committed. Never print or log
  the Garmin key or access token, and never put them in a tracked file.
- When asked for code, give complete files, never diffs or snippets.
- Two-space indent, single quotes, semicolons, ES modules.

## Safety

- Never open or print `.dev.vars`. Never commit `.dev.vars` or `seed/raw-sample.json`
  (personal Garmin data). The repo is meant to be public, so no secret may enter a
  tracked file or the git history.
- `USE_SAMPLE_DATA = true` is the default. Switching it to `false` calls the real Garmin
  API with the owner's key, so only do that when the task requires it.
