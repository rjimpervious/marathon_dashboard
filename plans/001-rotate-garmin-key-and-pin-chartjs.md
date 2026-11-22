# Plan 001: Rotate the exposed Garmin key and pin Chart.js with an integrity hash

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: this folder is not a git repository. From the
> project root (`running-dashboard/`), run
> `sha256sum public/index.html`
> and compare with the fingerprint below. On a mismatch, compare the "Current
> state" excerpt against the live file before proceeding; if the excerpt no
> longer matches, treat it as a STOP condition.
>
> `f27325d5d06507de8d9ebb9ea0d845a1c1fb0da09c265a156f57f0006f707769  public/index.html`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: no git repository (file fingerprints above), 2026-11-21

## Why this matters

Two independent hardening items for a dashboard that shows personal Garmin data:

1. **The Garmin Personal API key must be rotated.** The key is hardcoded in
   `src/config.js` line 1. That was a deliberate choice for local testing (the file is
   gitignored), but the key's value was displayed in an AI chat transcript while the
   project was being built. Anyone with access to that transcript can read the owner's
   Garmin data until the key is deleted. Garmin's FAQ: deleting a key immediately
   invalidates it and every access token created from it.
2. **Chart.js is loaded from cdnjs without Subresource Integrity (SRI).** If the CDN
   file were ever altered, it would run with full access to the page. An `integrity`
   attribute makes the browser refuse any file that does not match the pinned hash. The
   project owner chose cdnjs deliberately ("Chart.js from cdnjs is fine"), so this plan
   keeps cdnjs and only adds the hash.

## Current state

- `src/config.js` — gitignored settings file. Line 1 holds the Garmin Personal API key
  (`export const GARMIN_API_KEY = '…';`), line 2 `GARMIN_KEY_EXPIRES` (expiry date,
  `DD.MM.YYYY`, currently an empty string). **The executor must never open, print or
  edit this file.** Only the owner touches it (Part A).
- `public/index.html` — the dashboard page, served as a static asset by Wrangler.
  Line 91 today:

  ```html
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
  ```

  Line 92 is `<script type="module" src="/app.js"></script>` (leave it alone).
- `public/_headers` sets the Content-Security-Policy. Its `script-src` already allows
  `https://cdnjs.cloudflare.com`. SRI needs no CSP change.
- SRI value for exactly this file (Chart.js 4.4.1, `chart.umd.min.js`). It was verified
  twice when this plan was written: it equals the value cdnjs publishes at
  `https://api.cdnjs.com/libraries/Chart.js/4.4.1?fields=sri`, and it was computed
  independently from the downloaded file:

  `sha512-CQBWl4fJHWbryGE+Pc7UAxWMUMNMWzWxF4SQo9CgkJIN1kx6djDQZjh3Y8SZ1d+6I+1zze6Z7kHXO7q3UyZAWw==`

## Commands you will need

| Purpose | Command (run from `running-dashboard/`) | Expected on success |
|---|---|---|
| Recompute SRI | `curl -s https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js \| openssl dgst -sha512 -binary \| openssl base64 -A` | prints `CQBWl4fJ…AWw==` (the value above, without the `sha512-` prefix) |
| Local server | `npx wrangler dev` (keep running in a second terminal) | `Ready on http://localhost:8787` |
| Probe the key | `npm run probe` | first lines show `Token: POST … HTTP 200` |

## Scope

**In scope** (the only file the executor modifies):
- `public/index.html` — line 91 only.

**Owner-only (Part A, not the executor):**
- Creating and deleting keys in Garmin Connect, and editing `src/config.js`.

**Out of scope** (do NOT touch):
- `src/config.js` and `src/config.example.js` — secrets are the owner's job.
- `public/_headers` — the CSP already allows cdnjs; widening or narrowing it is a separate decision.
- Vendoring Chart.js into `public/` — a possible future option, but the owner chose cdnjs.

## Git workflow

Not a git repository. If the owner has run `git init` since (see `plans/README.md`),
work on branch `advisor/001-sri-chartjs` and commit with a short imperative message
such as `Pin Chart.js with an SRI hash`. Otherwise edit in place and list the changed
file in your report. Never commit `src/config.js`.

## Steps

### Part A — Owner: rotate the Garmin key (do this yourself; no agent)

1. Sign in at https://connect.garmin.com/app/settings/personalApiToken and select
   **Create Key**. Pick an expiration period and copy the new key (it is shown once).
2. In `src/config.js`, replace the value of `GARMIN_API_KEY` with the new key and set
   `GARMIN_KEY_EXPIRES` to the new expiry date as `DD.MM.YYYY`.
3. Run `npm run probe` from `running-dashboard/`.
   **Verify**: output starts with `Token: POST …` followed by `HTTP 200`.
4. Back on the Garmin page, **delete the old key** (the one created first, with the
   earlier creation date).
5. Optional: run `npm run probe` once more. It must still show `HTTP 200`, which proves
   the new key works and the old one was the deleted one.

### Part B — Executor: add the SRI hash to Chart.js

#### Step B1: Recompute the hash and confirm it matches the plan

Run the "Recompute SRI" command from the table.

**Verify**: the output equals
`CQBWl4fJHWbryGE+Pc7UAxWMUMNMWzWxF4SQo9CgkJIN1kx6djDQZjh3Y8SZ1d+6I+1zze6Z7kHXO7q3UyZAWw==`.
If it differs, STOP (see STOP conditions).

#### Step B2: Edit line 91 of `public/index.html`

Replace the Chart.js script tag with exactly:

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js" integrity="sha512-CQBWl4fJHWbryGE+Pc7UAxWMUMNMWzWxF4SQo9CgkJIN1kx6djDQZjh3Y8SZ1d+6I+1zze6Z7kHXO7q3UyZAWw==" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
```

`crossorigin="anonymous"` is required: without it the browser cannot check the integrity
of a cross-origin script. Keep the file's existing formatting (no comments, same
indentation).

**Verify**:
- `grep -c 'integrity="sha512-CQBWl4fJHWbryGE+Pc7UAxWMUMNMWzWxF4SQo9CgkJIN1kx6djDQZjh3Y8SZ1d+6I+1zze6Z7kHXO7q3UyZAWw=="' public/index.html` → `1`
- `grep -c 'crossorigin="anonymous"' public/index.html` → `1`
- `grep -c '<script type="module" src="/app.js"></script>' public/index.html` → `1`

#### Step B3: Smoke test in the running server

With `npx wrangler dev` running:

- `curl -s http://localhost:8787/ | grep -c 'integrity="sha512-CQBW'` → `1`
- If you have a browser tool: open `http://localhost:8787/`. The console must show no
  errors (an SRI mismatch logs "Failed to find a valid digest in the 'integrity'
  attribute"), and the two charts ("Weekly distance", "Average pace per week") must render.
- Without a browser: `curl -s http://localhost:8787/api/stats | grep -c '"weekly"'` → `1`
  (the API still answers; the page itself was not otherwise changed).

## Test plan

There is no automated browser test in this repository. Verification is the grep checks
in B2 and the smoke test in B3. There's no unit test to write for an HTML attribute.

## Done criteria

- [ ] Part A done by the owner: `npm run probe` shows `HTTP 200` with the new key, and the old key is deleted in Garmin Connect (the owner confirms in the status row)
- [ ] `grep -c 'integrity="sha512-CQBW' public/index.html` → `1`
- [ ] `grep -c 'crossorigin="anonymous"' public/index.html` → `1`
- [ ] Browser console shows no SRI error and both charts render (or the curl fallback in B3 passes)
- [ ] Only `public/index.html` changed by the executor
- [ ] `plans/README.md` status row updated

## STOP conditions

- The recomputed hash in B1 does not match the plan's value. The CDN file may have
  changed. Do not "fix" it by pasting the new hash; report it.
- Line 91 no longer loads Chart.js 4.4.1 from cdnjs (for example, a different version or
  Chart.js vendored locally).
- You are asked to, or think you need to, open or edit `src/config.js`.
- After B2 the browser console reports an integrity or CSP error.

## Maintenance notes

- **Upgrading Chart.js** means updating the version in the URL and the `integrity`
  value together. Take the new hash from
  `https://api.cdnjs.com/libraries/Chart.js/<version>?fields=sri`, and cross-check it
  with the recompute command.
- **Key rotation is recurring.** Garmin keys expire after 30, 90 or 180 days or one year.
  Keep `GARMIN_KEY_EXPIRES` current so the dashboard warns 14 days ahead.
- **Deferred:** moving the key out of `src/config.js` into `.dev.vars` or
  `wrangler secret` belongs to the deploy work (README "Later" section), not to this plan.
