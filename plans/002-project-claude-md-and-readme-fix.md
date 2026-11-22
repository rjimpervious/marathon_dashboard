# Plan 002: Give the project its own CLAUDE.md and fix the stale README path

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: this folder is not a git repository. From
> `running-dashboard/`, run `sha256sum README.md package.json` and compare:
>
> ```
> 1f83d41e5edf9c1afb117eb787a16d0dbd624eeed83921e0f2de0aeefc3c337b  README.md
> 1cb24bd29b98c7ddb1695f45e681363a095d3c3303670cea74b39afcc2a34c00  package.json
> ```
>
> A changed `package.json` is expected if plan 003 already ran (it adds a `test`
> script). For any other mismatch, compare the excerpts below with the live files;
> if they no longer match, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (run before 003–005 so their executors get correct instructions)
- **Category**: dx, docs
- **Planned at**: no git repository (file fingerprints above), 2026-11-21

## Why this matters

Claude Code loads every `CLAUDE.md` from the working directory up to the root. The
project lives at `D:\test\running-dashboard\`, and the parent folder `D:\test\` has a
`CLAUDE.md` describing a **different project** (an Astro hiking-booking site with Stripe,
`npm run build`, Tailwind). Any agent working in `running-dashboard/` currently starts
with wrong commands and a wrong stack. A project-level `CLAUDE.md` gives agents the real
commands, architecture and the owner's strict code-style rules. It also says explicitly
that the parent file does not apply.

The README also names the wrong file for a setting that a deploy step tells the reader
to change.

## Current state

- `D:\test\CLAUDE.md` (parent folder, **not part of this project**). It begins:
  "> **Note:** At the time of writing, the project exists only as `hiking-site.zip` in
  this folder. Everything below describes the `hiking-site/` directory inside that
  archive."
- There is no `D:\test\running-dashboard\CLAUDE.md`.
- `README.md` line 219 (section "Check that Garmin works from Cloudflare") says:
  "…lower `MAX_PAGES_PER_SYNC` in `src/index.js`, which spreads the history over several
  syncs…". The constant actually lives at `src/sync.js` line 6:
  `const MAX_PAGES_PER_SYNC = 40;`.
- Facts the new `CLAUDE.md` must state (verified when this plan was written):
  - Cloudflare Worker, plain JavaScript ES modules, no framework, no build step. Wrangler 4 is a devDependency.
  - `package.json` scripts: `dev` (`wrangler dev`), `dev:scheduled`
    (`wrangler dev --test-scheduled`), `probe` (`node scripts/probe.js`), `deploy`
    (`wrangler deploy`). There is no `test` script yet; plan 003 adds `npm test`.
  - `wrangler.toml`: `main = "src/index.js"`, `[assets] directory = "./public"`, KV
    binding `RUNS`, cron `0 */3 * * *`.
  - Source modules: `src/index.js` (API routes `GET /api/stats`, `GET /api/status`,
    `POST /api/refresh`, cron handler, picks the run source), `src/sync.js` (Garmin run
    source: sync lifecycle), `src/sample.js` (sample run source from
    `seed/sample-activities.json`), `src/store.js` (KV keys: `activities`, `meta`,
    `sync_lock`), `src/garmin.js` (Garmin token and activity fetching), `src/stats.js`
    (pure stats, projection, race countdown).
  - Page: `public/index.html`, `public/app.css`, `public/app.js` (ES module),
    `public/format.js`, `public/_headers` (CSP), served as static assets.
  - `src/config.js` is gitignored and holds the Garmin API key. `src/config.example.js`
    is the committed template. `seed/raw-sample.json` is gitignored personal data.

## Commands you will need

| Purpose | Command (from `running-dashboard/`) | Expected on success |
|---|---|---|
| Syntax check | `node --check src/index.js` | exit 0, no output |
| Show README line | `sed -n 219p README.md` | the line with `MAX_PAGES_PER_SYNC` |

## Scope

**In scope:**
- `CLAUDE.md` in `running-dashboard/` (create)
- `README.md` — line 219 only

**Out of scope** (do NOT touch):
- `D:\test\CLAUDE.md` — it belongs to the separate hiking-site project. Do not edit,
  move or delete it.
- Any source file under `src/`, `public/`, `scripts/`.
- Other README content. It was reviewed and is accurate apart from line 219.

## Git workflow

Not a git repository. If the owner has run `git init` since, use branch
`advisor/002-claude-md` with commit message `Add project CLAUDE.md, fix README path`.
Otherwise edit in place and list the changed files in your report.

## Steps

### Step 1: Create `running-dashboard/CLAUDE.md` with exactly this content

````markdown
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
npm test                            # node --test (only once package.json has a test script)
```

There is no linter, formatter or typecheck. To check a change: `node --check <file>`
for syntax, `npm test` if it exists, then `npx wrangler dev` and
`curl -s http://localhost:8787/api/stats`.

## Architecture

- `src/index.js`: Worker entry. API routes `GET /api/stats`, `GET /api/status` and
  `POST /api/refresh`, plus the `scheduled` (cron) handler. It picks the run source once
  per request: the sample source when `USE_SAMPLE_DATA` is true, otherwise the Garmin
  source.
- `src/sync.js`: Garmin run source and the sync lifecycle (rate-limit block, KV lock,
  backfill then incremental with a 3-day overlap, merge by activity id, sync meta).
- `src/sample.js`: sample run source from `seed/sample-activities.json`. It never calls Garmin.
- `src/store.js`: the only place that knows KV keys (`activities`, `meta`, `sync_lock`).
- `src/garmin.js`: Garmin token (cached in KV) and paginated activity search. It returns
  `{ ok: false, reason, message }` objects instead of throwing. `compact()` is the only
  place that translates Garmin fields into a stored run record.
- `src/stats.js`: pure functions. `computeStats(runs, { now, timezone, weekStartDay,
  goalSeconds, race })` returns everything the page shows.
- `public/`: static page (`index.html`, `app.css`, `app.js`, `format.js`) plus
  `_headers` (CSP without `'unsafe-inline'`). The Worker does not serve the page.

## Code style (owner's rules, strict)

- No comments in code.
- No CLI arguments. Settings are module-level constants at the top of the file.
- Credentials and personal settings live only in `src/config.js` (gitignored). Never
  print, log or commit the Garmin key or access tokens.
- When asked for code, give complete files, never diffs or snippets.
- Two-space indent, single quotes, semicolons, ES modules.

## Safety

- Never open or print `src/config.js` contents in output. Never commit it, or
  `seed/raw-sample.json` (personal Garmin data).
- `USE_SAMPLE_DATA = true` is the default. Switching it to `false` calls the real Garmin
  API with the owner's key, so only do that when the task requires it.
````

**Verify**:
- `test -f CLAUDE.md && echo exists` → `exists`
- `grep -c "does \*\*not\*\* apply here" CLAUDE.md` → `1`
- `grep -c "src/store.js" CLAUDE.md` → `1`

### Step 2: Fix README line 219

In `README.md`, change `` `MAX_PAGES_PER_SYNC` in `src/index.js` `` to
`` `MAX_PAGES_PER_SYNC` in `src/sync.js` ``. Change nothing else on the line.

**Verify**:
- `grep -c 'MAX_PAGES_PER_SYNC` in `src/sync.js`' README.md` → `1`
- `grep -c 'MAX_PAGES_PER_SYNC` in `src/index.js`' README.md` → `0`
- `grep -n "const MAX_PAGES_PER_SYNC" src/sync.js` → one match (confirms the README is now right)

## Test plan

Documentation only, so there are no automated tests. The grep checks above are the verification.

## Done criteria

- [ ] `running-dashboard/CLAUDE.md` exists with the content from Step 1
- [ ] `grep -c 'in `src/sync.js`' README.md` ≥ 1 and the `src/index.js` variant returns 0
- [ ] `D:\test\CLAUDE.md` unchanged (`sha256sum` the same before and after; record both values in your report)
- [ ] Only `CLAUDE.md` (new) and `README.md` changed
- [ ] `plans/README.md` status row updated

## STOP conditions

- `running-dashboard/CLAUDE.md` already exists. Report its content instead of overwriting.
- `src/sync.js` no longer defines `MAX_PAGES_PER_SYNC`. The README fix would then need a different target.
- You feel the need to change `D:\test\CLAUDE.md`. Don't. Report instead.

## Maintenance notes

- Plans 003–005 change commands and module roles. Each includes a step to keep this
  `CLAUDE.md` in sync.
- If the owner later moves `D:\test\CLAUDE.md` into the hiking-site folder, the
  "does not apply" note becomes harmless but can be removed.
