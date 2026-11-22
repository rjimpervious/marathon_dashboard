import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { GARMIN_ENDPOINTS } from '../src/garmin.js';

function readDevVar(name) {
  let text;
  try {
    text = readFileSync(fileURLToPath(new URL('../.dev.vars', import.meta.url)), 'utf8');
  } catch {
    return '';
  }
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0 && line.slice(0, index).trim() === name) return line.slice(index + 1).trim();
  }
  return '';
}

const GARMIN_API_KEY = readDevVar('GARMIN_API_KEY');

const TOKEN_URL = GARMIN_ENDPOINTS.tokenUrl;
const API_BASE = GARMIN_ENDPOINTS.apiBase;
const SEARCH_PATH = GARMIN_ENDPOINTS.searchPath;
const ACTIVITY_TYPES_PATH = '/activity-service/activity/activityTypes/simple';
const ACCESS_TOKEN_SCHEME = 'Bearer';
const TOKEN_ACCEPT_HEADER = '*/*';
const RUNNING_PARENT_KEY = GARMIN_ENDPOINTS.runningParentKey;
const TRAIL_SUBTYPE_KEY = 'trail_running';
const PAGE_LIMIT = GARMIN_ENDPOINTS.pageLimit;
const MAX_PAGES = 3;
const LIMIT_CAP_PROBE = 1000;
const TRAIL_SAMPLE_LIMIT = 10;
const DELAY_BETWEEN_REQUESTS_MS = 1000;
const REQUEST_TIMEOUT_MS = GARMIN_ENDPOINTS.requestTimeoutMs;
const OUTPUT_FILE = fileURLToPath(new URL('../seed/raw-sample.json', import.meta.url));
const PLACEHOLDER_KEY = GARMIN_ENDPOINTS.placeholderKey;
const SAFE_TOKEN_FIELD_PATTERN = /expir|type|scope|issued|valid|created|lifetime|ttl/i;
const INTERESTING_HEADER_PATTERN = /rate|limit|retry|quota|remaining|throttl/i;
const SECRET_HEADER_PATTERN = /cookie|authorization|token/i;
const SAFE_JWT_CLAIMS = ['exp', 'iat', 'nbf', 'iss', 'scope', 'scp', 'token_type'];
const REPORT_FIELDS = [
  'activityId',
  'activityName',
  'activityType',
  'startTimeLocal',
  'startTimeGMT',
  'beginTimestamp',
  'distance',
  'duration',
  'movingDuration',
  'elapsedDuration',
  'elevationGain',
  'averageHR',
  'averageSpeed',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headersToObject(headers) {
  const out = {};
  for (const [key, value] of headers.entries()) {
    if (!SECRET_HEADER_PATTERN.test(key)) out[key] = value;
  }
  return out;
}

async function request(label, url, init, { summarize = false } = {}) {
  const started = Date.now();
  const entry = { label, method: init.method || 'GET', url };
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    entry.status = res.status;
    entry.ok = res.ok;
    entry.durationMs = Date.now() - started;
    entry.headers = headersToObject(res.headers);
    const text = await res.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (summarize && Array.isArray(body)) {
      entry.bodySummary = {
        count: body.length,
        firstId: body.length ? body[0].activityId : null,
        lastId: body.length ? body[body.length - 1].activityId : null,
      };
      entry.body = body;
    } else {
      entry.body = body;
    }
  } catch (err) {
    entry.ok = false;
    entry.durationMs = Date.now() - started;
    entry.error = String(err && err.message ? err.message : err);
  }
  return entry;
}

function findAccessToken(body) {
  if (typeof body === 'string') return body.trim() || null;
  if (!body || typeof body !== 'object') return null;
  for (const key of ['access_token', 'accessToken', 'token']) {
    if (typeof body[key] === 'string') return body[key];
  }
  for (const [key, value] of Object.entries(body)) {
    if (/token/i.test(key) && !/refresh/i.test(key) && typeof value === 'string') return value;
  }
  return null;
}

function redactTokenResponse(body) {
  if (typeof body === 'string') return { format: 'text', length: body.length, value: '[redacted]' };
  if (!body || typeof body !== 'object') return { format: typeof body };
  const fields = {};
  for (const [key, value] of Object.entries(body)) {
    if (SAFE_TOKEN_FIELD_PATTERN.test(key) && (typeof value !== 'string' || value.length < 80)) {
      fields[key] = value;
    } else {
      fields[key] = '[redacted ' + typeof value + (typeof value === 'string' ? ', length ' + value.length : '') + ']';
    }
  }
  return { format: 'json', fields };
}

function jwtInfo(token) {
  if (!token || token.split('.').length !== 3) return { isJwt: false };
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const safe = {};
    for (const claim of SAFE_JWT_CLAIMS) {
      if (payload[claim] !== undefined) safe[claim] = payload[claim];
    }
    if (typeof payload.exp === 'number') safe.expIso = new Date(payload.exp * 1000).toISOString();
    if (typeof payload.iat === 'number') safe.iatIso = new Date(payload.iat * 1000).toISOString();
    if (typeof payload.exp === 'number' && typeof payload.iat === 'number') safe.lifetimeHours = (payload.exp - payload.iat) / 3600;
    return { isJwt: true, claimNames: Object.keys(payload), safeClaims: safe };
  } catch {
    return { isJwt: true, decodeError: true };
  }
}

function typeKeyOf(activity) {
  const t = activity && activity.activityType;
  if (!t) return null;
  if (typeof t === 'string') return t;
  return t.typeKey || t.key || JSON.stringify(t);
}

function describeValue(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return typeof value + ' ' + JSON.stringify(value);
}

function interestingHeaders(entries) {
  const seen = {};
  for (const entry of entries) {
    for (const [key, value] of Object.entries(entry.headers || {})) {
      if (INTERESTING_HEADER_PATTERN.test(key)) seen[key] = value;
    }
  }
  return seen;
}

function statusLine(entry) {
  if (!entry) return 'not called';
  if (entry.error) return 'network error: ' + entry.error;
  const count = Array.isArray(entry.body) ? ', ' + entry.body.length + ' items' : '';
  return 'HTTP ' + entry.status + count + ', ' + entry.durationMs + ' ms';
}

function printReport(log) {
  const lines = [];
  const byLabel = Object.fromEntries(log.requests.map((r) => [r.label, r]));
  lines.push('');
  lines.push('=== Garmin Personal API probe ===');
  lines.push('Token: POST ' + TOKEN_URL);
  lines.push('  ' + statusLine(log.token));
  lines.push('  content-type: ' + ((log.token.headers || {})['content-type'] || 'n/a'));
  lines.push('  response: ' + JSON.stringify(log.token.response));
  lines.push('  jwt: ' + JSON.stringify(log.token.jwt));
  if (!log.accessTokenFound) {
    lines.push('No access token obtained. Stopping.');
    if (log.token.status === 401 || log.token.status === 403) lines.push('Garmin key invalid or expired (HTTP ' + log.token.status + ').');
    console.log(lines.join('\n'));
    return;
  }

  lines.push('');
  lines.push('Activity types (' + ACTIVITY_TYPES_PATH + '): ' + statusLine(byLabel['activity-types']));
  const types = byLabel['activity-types'];
  if (types && Array.isArray(types.body)) {
    const runningFamily = types.body.filter((t) => t.key === RUNNING_PARENT_KEY || t.parent === RUNNING_PARENT_KEY);
    lines.push('  running family: ' + runningFamily.map((t) => t.key + (t.parent ? ' (parent ' + t.parent + ')' : ' (parent type)')).join(', '));
  }

  lines.push('');
  lines.push('Search running (' + SEARCH_PATH + '?activityType=' + RUNNING_PARENT_KEY + ', limit=' + PAGE_LIMIT + '):');
  const pages = log.requests.filter((r) => r.label.startsWith('running-page-'));
  for (const page of pages) lines.push('  ' + page.label + ': ' + statusLine(page));
  const allRuns = pages.flatMap((p) => (Array.isArray(p.body) ? p.body : []));
  const uniqueIds = new Set(allRuns.map((a) => a.activityId));
  lines.push('  fetched ' + allRuns.length + ' activities, ' + uniqueIds.size + ' unique ids');
  if (allRuns.length > 1) {
    lines.push('  order: first ' + allRuns[0].startTimeLocal + ', last ' + allRuns[allRuns.length - 1].startTimeLocal);
  }
  const typeCounts = {};
  for (const a of allRuns) {
    const key = typeKeyOf(a);
    typeCounts[key] = (typeCounts[key] || 0) + 1;
  }
  lines.push('  activityType keys in results: ' + JSON.stringify(typeCounts));

  lines.push('');
  lines.push('Limit cap probe (limit=' + LIMIT_CAP_PROBE + '): ' + statusLine(byLabel['limit-cap']));
  lines.push('Trail running (activitySubType=' + TRAIL_SUBTYPE_KEY + '): ' + statusLine(byLabel['trail-running']));
  const trail = byLabel['trail-running'];
  if (trail && Array.isArray(trail.body) && trail.body.length) {
    lines.push('  trail activityType: ' + JSON.stringify(trail.body[0].activityType));
  }
  const oldestRun = byLabel['oldest-running'];
  const oldestAny = byLabel['oldest-any'];
  lines.push('Oldest running activity: ' + (oldestRun && Array.isArray(oldestRun.body) && oldestRun.body[0] ? oldestRun.body[0].startTimeLocal : statusLine(oldestRun)));
  lines.push('Oldest activity of any type: ' + (oldestAny && Array.isArray(oldestAny.body) && oldestAny.body[0] ? oldestAny.body[0].startTimeLocal : statusLine(oldestAny)));

  if (allRuns.length) {
    const sample = allRuns[0];
    lines.push('');
    lines.push('Selected fields of the newest run:');
    for (const field of REPORT_FIELDS) lines.push('  ' + field + ': ' + describeValue(sample[field]));
    if (sample.distance && sample.duration) {
      lines.push('  derived pace from distance/duration: ' + (sample.duration / (sample.distance / 1000) / 60).toFixed(2) + ' min/km');
    }
    if (sample.averageSpeed && sample.distance) {
      lines.push('  cross-check distance/averageSpeed: ' + (sample.distance / sample.averageSpeed).toFixed(0) + ' s');
    }
    lines.push('  total field count: ' + Object.keys(sample).length);
    lines.push('  all field names: ' + Object.keys(sample).sort().join(', '));
  }

  lines.push('');
  lines.push('Rate-limit related headers seen: ' + JSON.stringify(interestingHeaders([log.token, ...log.requests])));
  lines.push('Raw responses saved to ' + OUTPUT_FILE);
  console.log(lines.join('\n'));
}

async function save(log) {
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(OUTPUT_FILE, JSON.stringify(log, null, 2), 'utf8');
}

async function main() {
  if (!GARMIN_API_KEY || GARMIN_API_KEY === PLACEHOLDER_KEY) {
    console.error('Set GARMIN_API_KEY in .dev.vars before running the probe.');
    process.exitCode = 1;
    return;
  }

  const log = {
    probedAt: new Date().toISOString(),
    settings: { API_BASE, SEARCH_PATH, ACTIVITY_TYPES_PATH, ACCESS_TOKEN_SCHEME, PAGE_LIMIT, MAX_PAGES, LIMIT_CAP_PROBE },
    token: null,
    accessTokenFound: false,
    requests: [],
  };

  const tokenEntry = await request('token', TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: 'ApiKey ' + GARMIN_API_KEY, Accept: TOKEN_ACCEPT_HEADER },
  });
  const accessToken = tokenEntry.ok ? findAccessToken(tokenEntry.body) : null;
  log.token = {
    status: tokenEntry.status,
    ok: tokenEntry.ok,
    durationMs: tokenEntry.durationMs,
    error: tokenEntry.error,
    headers: tokenEntry.headers,
    response: tokenEntry.ok ? redactTokenResponse(tokenEntry.body) : tokenEntry.body,
    jwt: jwtInfo(accessToken),
  };
  log.accessTokenFound = Boolean(accessToken);

  if (!accessToken) {
    await save(log);
    printReport(log);
    process.exitCode = 1;
    return;
  }

  const authHeaders = { Authorization: ACCESS_TOKEN_SCHEME + ' ' + accessToken, Accept: 'application/json' };
  const get = async (label, path, params, options) => {
    await sleep(DELAY_BETWEEN_REQUESTS_MS);
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    const entry = await request(label, API_BASE + path + query, { headers: authHeaders }, options);
    log.requests.push(entry);
    return entry;
  };

  const types = await get('activity-types', ACTIVITY_TYPES_PATH);
  if (types.status === 401 || types.status === 403) {
    console.warn('API call rejected with HTTP ' + types.status + ' using the ' + ACCESS_TOKEN_SCHEME + ' scheme.');
  }

  for (let page = 0; page < MAX_PAGES; page++) {
    const entry = await get('running-page-' + (page + 1), SEARCH_PATH, {
      activityType: RUNNING_PARENT_KEY,
      start: String(page * PAGE_LIMIT),
      limit: String(PAGE_LIMIT),
      sortOrder: 'desc',
    });
    if (!entry.ok || !Array.isArray(entry.body) || entry.body.length < PAGE_LIMIT) break;
  }

  await get('trail-running', SEARCH_PATH, {
    activityType: RUNNING_PARENT_KEY,
    activitySubType: TRAIL_SUBTYPE_KEY,
    start: '0',
    limit: String(TRAIL_SAMPLE_LIMIT),
  });
  await get('oldest-running', SEARCH_PATH, { activityType: RUNNING_PARENT_KEY, start: '0', limit: '1', sortOrder: 'asc' });
  await get('oldest-any', SEARCH_PATH, { start: '0', limit: '1', sortOrder: 'asc' });
  const cap = await get('limit-cap', SEARCH_PATH, { activityType: RUNNING_PARENT_KEY, start: '0', limit: String(LIMIT_CAP_PROBE) }, { summarize: true });
  if (cap.bodySummary) delete cap.body;

  await save(log);
  printReport(log);
}

main().catch((err) => {
  console.error('Probe failed: ' + (err && err.message ? err.message : err));
  process.exitCode = 1;
});
