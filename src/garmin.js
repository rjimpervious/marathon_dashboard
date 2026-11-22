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

function addIfPresent(record, key, value, transform) {
  if (value === null || value === undefined) return;
  record[key] = transform ? transform(value) : value;
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
  addIfPresent(record, 'maxHR', activity.maxHR, Math.round);
  addIfPresent(record, 'movingDuration', activity.movingDuration, round1);
  addIfPresent(record, 'cadence', activity.averageRunningCadenceInStepsPerMinute, Math.round);
  addIfPresent(record, 'strideLength', activity.avgStrideLength, round1);
  addIfPresent(record, 'calories', activity.calories, Math.round);
  addIfPresent(record, 'elevationLoss', activity.elevationLoss, round1);
  addIfPresent(record, 'vo2max', activity.vO2MaxValue, round1);
  addIfPresent(record, 'locationName', activity.locationName);
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
