# Running Dashboard

A personal running dashboard that runs as a Cloudflare Worker. It pulls your runs from the Garmin Connect Personal API every 3 hours, stores compact records in Workers KV and serves a single dashboard page.

It is plain JavaScript with ES modules. There is no framework and no build step of your own. The page is served as static files from `public/` (Workers Static Assets), and the Worker in `src/` only answers `/api/*` and runs the cron.

The dashboard shows:
- Runs and kilometres this week (Monday to Sunday)
- Kilometres this month and this year, with trail kilometres listed separately
- A weekly distance bar chart for the last 16 weeks
- The longest run of the last 8 weeks
- A weekly average-pace chart with your goal pace drawn as a dashed line
- A Riegel marathon projection next to your goal time, with the gap and a confidence note
- The last sync time, when your Garmin key expires, and a "Refresh now" button

Units are metric, dates use DD.MM.YYYY, weeks start on Monday and "today" is taken in Europe/Berlin.

## Project layout

```
running-dashboard/
├── package.json
├── wrangler.toml                static assets, KV binding RUNS, cron every 3 hours
├── public/                      the dashboard, served as static files
│   ├── index.html               markup and the background track
│   ├── app.css                  styles
│   ├── app.js                   fetches /api/stats and renders (ES module)
│   ├── format.js                duration and pace formatting
│   ├── favicon.svg
│   └── _headers                 Content-Security-Policy and other headers
├── scripts/probe.js             one-off API probe (see step 2)
├── scripts/link.js              prints your private link (npm run link)
├── .dev.vars                    your two secrets, local only, gitignored
├── seed/
│   ├── sample-activities.json   40 fake runs for sample mode
│   └── raw-sample.json          probe output, personal data, gitignored
└── src/
    ├── config.js                your settings, no secrets (committed)
    ├── index.js                 Worker entry: API routes, cron, picks the run source
    ├── gate.js                  secret-link check (cookie), skipped on localhost
    ├── sync.js                  Garmin run source: sync lifecycle (backfill, incremental, lock)
    ├── sample.js                sample run source: seed runs, never calls Garmin
    ├── store.js                 KV keys for runs, sync meta and the sync lock
    ├── garmin.js                token handling and activity fetching
    └── stats.js                 pure stats and projection functions
```

## Requirements

- Node.js 18 or newer (tested with Node 26)
- A Garmin Connect account with a Personal API key
- Wrangler 4, installed as a dev dependency by `npm install`

## Setup

```powershell
npm install
```

Settings that are not secret live in `src/config.js`, which is committed:

| Setting | Meaning |
|---|---|
| `GARMIN_KEY_EXPIRES` | The key's expiry date as `DD.MM.YYYY`, for example `'21.11.2027'` |
| `GOAL_MARATHON_SECONDS` | Goal marathon time in seconds, default `4 * 3600` |
| `RACE_NAME`, `RACE_PLACE` | Name and place of your goal race, shown in the countdown |
| `RACE_DATE` | Race date as `DD.MM.YYYY`, for example `'11.04.2027'`. Leave it empty to hide the countdown |
| `MAX_HEART_RATE` | Your max heart rate in bpm (Garmin shows it in your profile). Together with `RESTING_HEART_RATE` it turns on the heart-rate projections; set either to `null` to hide them |
| `RESTING_HEART_RATE` | Your resting heart rate in bpm (Garmin shows it in your daily heart rate; it was 53 to 58 in the week this was set up) |
| `WEEK_START_DAY` | `1` means weeks start on Monday |
| `TIMEZONE` | Time zone for "today", default `'Europe/Berlin'` |
| `LOCALE` | Date and time format, default `'de-DE'` |
| `NUMBER_LOCALE` | Number format, default `'en-GB'` (dot for decimals, comma for thousands). Use `'de-DE'` for decimal commas |
| `USE_SAMPLE_DATA` | `true` shows `seed/sample-activities.json` and never calls Garmin |
| `SAMPLE_SHIFT_TO_TODAY` | Moves the sample dates forward in whole weeks so the demo stays current |

`src/config.js` also holds personal numbers such as your heart rates and goal. If you publish the repository and do not want those public, change them to neutral values before you do.

### Reusing the dashboard for another event

The event is configured in the first block of `src/config.js`: `RACE_NAME`, `RACE_PLACE`, `RACE_DATE` and the goal time. To switch events, change those values and run `npx wrangler deploy`. An empty `RACE_DATE` hides the countdown. The projection and the goal are still for the marathon distance.

### Secrets

Two secrets are never in the code or the repository:

| Secret | What it is |
|---|---|
| `GARMIN_API_KEY` | Your Garmin Personal API key |
| `ACCESS_TOKEN` | The secret for the private link, at least 16 characters (see "Sharing the dashboard") |

Locally they go into a file named `.dev.vars` in the project folder. It is in `.gitignore`, and `wrangler dev` reads it when it starts:

```
GARMIN_API_KEY=paste-your-garmin-key-here
ACCESS_TOKEN=paste-a-long-random-string-here
```

Generate a token with:

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

In production the same two values are Cloudflare secrets (see "Deploying"). The deployed Worker fails closed: if `ACCESS_TOKEN` is missing, it refuses every request on the real domain. On `localhost` it needs no token. Restart `wrangler dev` after you change `.dev.vars`.

## Local testing

### 1. Create the Garmin key

1. Sign in to Garmin Connect on the web and open the Personal API Key page: <https://connect.garmin.com/app/settings/personalApiToken>.
2. Select **Create Key**, accept the terms and choose an expiration period (30 days, 90 days, 180 days or one year).
3. Copy the key straight away. Garmin shows it only once.
4. Put it into `GARMIN_API_KEY` in `.dev.vars` (see "Secrets"), and set it in production with `npx wrangler secret put GARMIN_API_KEY`.
5. Put the expiry date shown on that page into `GARMIN_KEY_EXPIRES` as `DD.MM.YYYY`.

A chip beside the Refresh button counts the days left. It turns amber 14 days before that date and red, with a "Renew your Garmin key now" banner, 2 days before. If Garmin rejects the key (HTTP 401 or 403), the dashboard shows "Garmin key invalid or expired" in the chip, in a red banner and in the Refresh message, and keeps your stored runs.

### 2. Run the probe

The probe checks that your key works and shows what the API returns. It needs no arguments; its settings are constants at the top of `scripts/probe.js`.

```powershell
npm run probe
```

It gets an access token, then lists the activity types and up to three pages of your running activities. It also checks trail-run filtering, your oldest activity and the page-size limit. It prints a summary and saves the raw responses to `seed/raw-sample.json`. That file contains personal data (names, GPS start and end points), so it is gitignored. The key and the token are never printed or saved.

### 3. Look at the layout with sample data

Leave `USE_SAMPLE_DATA = true` and start the local server:

```powershell
npx wrangler dev
```

Open <http://localhost:8787>. The page shows the 40 fake runs from `seed/sample-activities.json` with a "Sample data" banner. In sample mode "Refresh now" and the cron make no Garmin calls.

### 4. Sync your real runs

Set `USE_SAMPLE_DATA = false` in `src/config.js`. Wrangler reloads on its own; if it doesn't, stop it and start it again. Then either press "Refresh now" on the dashboard or run:

```powershell
curl.exe -X POST "http://localhost:8787/api/refresh"
```

The response contains the sync result (`status`, `added`, `updated`, `storedRuns`) and the new stats. The first sync fetches your whole history. Later syncs only fetch recent runs.

### 5. Test the cron trigger

Start Wrangler with scheduled-event testing turned on:

```powershell
npx wrangler dev --test-scheduled
```

In a second terminal, fire the cron handler:

```powershell
curl.exe "http://localhost:8787/__scheduled"
```

To pass the exact cron expression from `wrangler.toml`:

```powershell
curl.exe "http://localhost:8787/__scheduled?cron=0+*/3+*+*+*"
```

The Wrangler terminal then logs a line such as `[sync] cron: ok, 0 new, 1 updated, 312 stored`, or `[sync] cron: sample mode, Garmin not called` when `USE_SAMPLE_DATA` is `true`.

### 6. Check the sync status

```powershell
curl.exe "http://localhost:8787/api/status"
```

This returns the last sync time, the number of stored runs, the last status, the last error if any, the key expiry and when the cached token expires.

### Local data

`wrangler dev` simulates KV on disk under `.wrangler/state`. To start over with an empty store, stop Wrangler and delete that folder:

```powershell
Remove-Item -Recurse -Force .wrangler/state
```

## Routes

| Route | What it does |
|---|---|
| `GET /` | The dashboard page, `public/index.html` (static asset, the Worker is not involved) |
| `GET /api/stats` | Stats computed from KV, plus a `status` block. Never calls Garmin |
| `POST /api/refresh` | Runs a sync, then returns `{ sync, stats }` |
| `GET /api/status` | Last sync, stored runs, last status and error, key and token expiry |
| `GET /api/runs?ids=1,2` | Full details of up to 10 stored runs, for the run details page |

## How it works

**Authentication.** The Personal API key can't call the data endpoints directly. The Worker sends it as `Authorization: ApiKey <key>` to Garmin's token endpoint and gets back an access token, which is a plain-text JWT valid for 24 hours. There are no refresh tokens. The Worker caches the token in KV and reuses it until 10 minutes before it expires, then requests a new one. Data calls send `Authorization: Bearer <token>`. If a data call is rejected, the Worker requests one new token and retries once. If that fails too, the status becomes `key_invalid`.

**Fetching.** Activities come from `GET /activitylist-service/activities/search/activities` with `activityType=running`, newest first, 100 per page. Page sizes of 200 or more return HTTP 500. The Worker waits 1 second between pages.

**First sync.** The first sync fetches your full history. One run fetches at most 40 pages (4,000 activities). If the history is longer, or the run is interrupted, the next sync resumes from the oldest date already stored.

**Later syncs.** These are incremental. They ask for activities from 3 days before the newest stored run onward, so late uploads and edits to recent runs are picked up. Records are deduplicated by activity id.

**Errors.** Stored runs are only ever added to or updated, never removed. A 401, 403, 429, network error or bad response is recorded in KV as `lastError` and shown on the dashboard and in `/api/status`. Garmin documents no rate limits and sends no rate-limit headers. On HTTP 429 the Worker pauses syncing for the `Retry-After` time, or 15 minutes if Garmin sends none. A KV lock stops the cron run and the button from syncing at the same time.

**Stored records.** Each run is stored as `{ id, name, type, startLocal, distance, duration, elevationGain, averageHR }`:
- `distance` is in metres.
- `duration` is Garmin's timer time in seconds.
- `startLocal` is the local time where you ran.
- `averageHR` is left out when Garmin has none, and `elevationGain` is `null` when missing.

Every running subtype counts as a run, including treadmill, track and virtual runs. `type` keeps the subtype, so trail runs (`trail_running`) can be shown separately.

**Dates.** A run counts on the calendar date in `startLocal`, the local date where you ran. "Today", the current week, month and year are taken in `TIMEZONE`.

**Marathon projection.** With `MAX_HEART_RATE` and `RESTING_HEART_RATE` set, the headline time and the 5K, 10K and half marathon come from the heart-rate method described below, and the pace-only Riegel numbers appear in a labelled comparison row. Without them, Riegel is the headline. Riegel uses the formula T2 = T1 × (42.195 / D1)^1.06. Every run of at least 5 km in the last 8 weeks is converted with its full duration and distance, and the lowest result is used. If your longest run in the last 6 weeks is shorter than 28 km, the dashboard warns that the projection is optimistic. The goal pace is `GOAL_MARATHON_SECONDS / 42.195` per km, drawn as a dashed line on the pace chart.

**Heart-rate projections.** Riegel only sees pace, so a runner who trains mostly easy gets slow projections. The heart-rate method estimates fitness from how hard the heart works at a given pace, in three steps:
1. Heart rate reserve: `(average HR − resting HR) / (max HR − resting HR)`. It tracks the share of your oxygen-uptake reserve you were using (Swain and Leutholtz, 1997). It uses `MAX_HEART_RATE` and `RESTING_HEART_RATE` from `src/config.js`.
2. The run's pace gives the oxygen it costs: `VO2 = −4.60 + 0.182258·v + 0.000104·v²`, with `v` in metres per minute (Daniels and Gilbert). That run's VO2max is `(VO2 − 3.5) / reserve + 3.5`.
3. The median over your eligible runs (at least 5 km, last 8 weeks, between 50% and 90% of heart rate reserve, at least 3 runs) is turned into race times with Daniels' VDOT equations. They were checked against Daniels' published values (5K in 20:00 is 49.8, 10K in 40:00 is 51.9).

The first version used the share of max heart rate alone, ignoring resting heart rate. That was too optimistic: it put a 5K at 24:40 while Garmin's own prediction was 28:56. With resting heart rate included (55 bpm, as Garmin measured), the same runs give 29:14, within 20 seconds of Garmin. The reserve estimates also stay consistent from easy to harder runs, which the first version did not.

Checked against Garmin's own race predictions (5K 28:56, 10K 1:00:37, half 2:15:16, marathon 4:48:03, entered on 21.11.2026): with max 207 and resting 55 the model gives 29:14, 1:00:46 and 2:14:38 for the first three, within about 1% of Garmin. Garmin's four predictions all imply the same fitness (VDOT about 32). Its VO2max of 46 does not drive them: a VDOT of 46 would predict a 21:24 5K, so Garmin's predictor follows how you actually train, not that ceiling.

**Marathon long-run adjustment.** The marathon is the one distance where the plain equation was clearly faster than Garmin (4:36:43 against 4:48:03). A marathon needs long runs, and your longest recent run was 12 km. So the heart-rate marathon time adds up to 7% (`LONG_RUN_MAX_PENALTY` in `src/stats.js`), scaled by how far your longest run in the last 6 weeks falls short of 28 km, and the extra time reaches zero at 28 km. For 12.05 km that is +4.0%, giving 4:47:45. The 7% was fitted to this one comparison with Garmin, so treat it as a calibrated estimate, not a measured constant. The page shows the "trained for the distance" time next to it, and the marathon projection improves as your long runs grow. The 5K, 10K and half marathon are not adjusted.

It is still an estimate, not a measurement. It assumes `MAX_HEART_RATE` is your real maximum; if your true maximum is lower, the times come out too fast. Update `RESTING_HEART_RATE` now and then (Garmin shows it in your daily heart rate). Heat, fatigue and cardiac drift on long runs raise heart rate and make fitness look worse. The marathon time assumes you are trained for the distance, so the optimistic-projection warning applies to it too.

**Calendar.** The Calendar button next to "This week" opens `/calendar`: the last five weeks (this week and the four before it) as a grid, Monday to Sunday, with each run day's distance and average heart rate in red, a weekly total per row, and a link from every run day to its details. Five rolling weeks are shown, not a calendar month, because a month view is nearly empty in its first days. Week tiles on the dashboard also show the day's average heart rate, weighted by run duration when there are several runs. The most recent run day carries a glowing green dot, and the Today marker sits at the top of its tile.

**Run details.** Each day tile with a run links to `/run` (a page of its own). Pace (cyan) and average heart rate (red) get the large tiles, with the pace as km/h and the heart rate against your max, resting heart rate and heart rate reserve. Below them are distance, time, elevation, cadence with stride, and calories, in green, plus the fitness estimate from that run. A day with several runs shows one card per run. These fields are stored with each run. When their format changes (`RECORD_VERSION` in `src/sync.js`), the next sync reloads the whole history once, then goes back to incremental syncs.

**Other distances.** The same rule gives projections for 5K, 10K and the half marathon: for each distance, every eligible run (at least 5 km, last 8 weeks) is converted with Riegel and the lowest result wins, so each distance can come from a different run. The run behind a projection shows as a tooltip on its tile. These come from whole training runs, which are usually slower than race effort, so treat them as a lower bound on your fitness, not a race prediction.

**KV keys.**
- `activities`: compact runs, newest first
- `meta`: sync state and last error
- `garmin_token`: cached access token, expires with the token
- `sync_lock`: short-lived lock

## Sharing the dashboard (secret link)

The deployed dashboard is served at `https://run.rjlopez.me`. The Worker checks every request itself (`src/gate.js`) and shows only "Private. You need the link." without a valid cookie. It skips the check on `localhost`, so local testing is unaffected.

Print the private link on your machine (it contains the secret, so share it only with people you want to have access):

```powershell
npm run link
```

It reads `ACCESS_TOKEN` from `.dev.vars`. Opening the link sets a cookie that lasts one year and redirects to the clean address, so nobody types anything. That also means anyone who gets the link can open the dashboard, including its refresh button.

To revoke access for everyone, generate a new token (command under "Secrets"), put it in `.dev.vars`, set it in production and everyone's old link and cookie stop working:

```powershell
npx wrangler secret put ACCESS_TOKEN
```

Paste the new value when it asks. Then run `npm run link` for the new link.

## Deploying

The Worker is deployed with `npx wrangler deploy`. Settings in `wrangler.toml`: the static page in `public/` is served through the Worker (`run_worker_first`), the KV namespace `RUNS` holds the data, the cron runs every 3 hours, and the custom domain `run.rjlopez.me` is attached as a Worker Custom Domain (Cloudflare creates the DNS record and the certificate itself).

The two secrets are set once per Cloudflare account and are not part of any deploy:

```powershell
npx wrangler secret put GARMIN_API_KEY
```

```powershell
npx wrangler secret put ACCESS_TOKEN
```

Each command asks you to paste the value, which is stored encrypted by Cloudflare and never printed. `npx wrangler secret list` shows their names only.

A fresh copy of this project needs its own KV namespace (`npx wrangler kv namespace create RUNS`, then its id in `wrangler.toml`), its own domain in the `routes` line, and its own two secrets.

## Publishing the repository

The code is safe to publish only while no secret is in it or in its history. Before making the repository public:

1. `src/config.js` and the other tracked files contain no key or token. Check by searching for the start of your key and token with `git grep -n "<first 8 characters>"`, which should find nothing.
2. The git history contains no key or token either. History keeps everything that was ever committed, so a secret that was committed once stays readable there, even after the file is fixed. If a secret was ever committed, rotate it (new Garmin key, new `ACCESS_TOKEN`) and publish a history that starts clean.
3. `.dev.vars` and `seed/raw-sample.json` stay out of git (both are in `.gitignore`).

## Later (not built yet)

These steps are documented here only. None of them are set up.

### Check that Garmin works from Cloudflare

So far the API has only been tested from your own machine. After deploying, run `POST /api/refresh` against the deployed URL and watch the logs with `npx wrangler tail`. Garmin's API itself sits behind Cloudflare, but it may still treat requests from Workers differently from your home connection.

Also check the Workers plan limits. The free plan allows 50 outgoing requests and 10 ms of CPU time per invocation. A first sync of a long history can go over that. In that case, lower `MAX_PAGES_PER_SYNC` in `src/sync.js`, which spreads the history over several syncs, or use the Workers Paid plan.

### Restrict access

Your Garmin data is personal, and the Personal API is meant for your own use only. The secret link (`src/gate.js`) protects every route on the custom domain, including `POST /api/refresh`. Cloudflare Access (policy: your own email) protects the `workers.dev` address while it is enabled. Better still, turn the `workers.dev` address off (`workers_dev = false` in `wrangler.toml`) so the secret link is the only way in. The cron trigger is not affected by either.

### Renew the Garmin key

Garmin emails you about a week before the key expires, and the dashboard warns 14 days before `GARMIN_KEY_EXPIRES` (amber) and again 2 days before (red). To renew:
1. Create a new key on the Personal API Key page.
2. Update `GARMIN_API_KEY` in `.dev.vars`, and run `npx wrangler secret put GARMIN_API_KEY` for production.
3. Update `GARMIN_KEY_EXPIRES` in `src/config.js`.
4. Delete the old key.

The cached token from the old key stops working once that key is deleted, and the Worker then requests a new token with the new key.
