import { createGarminClient, isKeyConfigured } from './garmin.js';
import { evaluateGate } from './gate.js';
import { sampleSource } from './sample.js';
import { computeStats, describeRunDetail, keyExpiryInfo } from './stats.js';
import { kvStore } from './store.js';
import { garminSource } from './sync.js';
import {
  GARMIN_KEY_EXPIRES,
  GOAL_MARATHON_SECONDS,
  LOCALE,
  NUMBER_LOCALE,
  MAX_HEART_RATE,
  RACE_DATE,
  RESTING_HEART_RATE,
  RACE_NAME,
  RACE_PLACE,
  SAMPLE_SHIFT_TO_TODAY,
  TIMEZONE,
  USE_SAMPLE_DATA,
  WEEK_START_DAY,
} from './config.js';

const API_PATHS = ['/api/stats', '/api/status', '/api/refresh', '/api/runs'];
const MAX_RUN_IDS = 10;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function denied(status) {
  const body = status === 503 ? 'Access token is misconfigured.' : 'Private. You need the link.';
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}

function runSource(env, now) {
  if (USE_SAMPLE_DATA) return sampleSource({ now, timezone: TIMEZONE, shiftToToday: SAMPLE_SHIFT_TO_TODAY });
  const store = kvStore(env.RUNS);
  return garminSource({ store, garmin: createGarminClient({ apiKey: env.GARMIN_API_KEY, tokenStore: store }) });
}

function statusFrom(source, meta, tokenExpiresAt, now, keyConfigured) {
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
    keyConfigured,
    keyExpiry: keyExpiryInfo(GARMIN_KEY_EXPIRES, { now, timezone: TIMEZONE }),
    tokenExpiresAt,
  };
}

async function buildStatus(source, now, keyConfigured) {
  const [meta, tokenExpiresAt] = await Promise.all([source.meta(), source.tokenExpiresAt()]);
  return statusFrom(source, meta, tokenExpiresAt, now, keyConfigured);
}

function statsFrom(runs, status, now) {
  const stats = computeStats(runs, {
    now,
    timezone: TIMEZONE,
    weekStartDay: WEEK_START_DAY,
    goalSeconds: GOAL_MARATHON_SECONDS,
    race: { name: RACE_NAME, date: RACE_DATE, place: RACE_PLACE },
    maxHeartRate: MAX_HEART_RATE,
    restingHeartRate: RESTING_HEART_RATE,
  });
  return { ...stats, locale: LOCALE, numberLocale: NUMBER_LOCALE, status };
}

async function buildStats(source, now, keyConfigured) {
  const [runs, status] = await Promise.all([source.runs(), buildStatus(source, now, keyConfigured)]);
  return statsFrom(runs, status, now);
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
  const route = request.method + ' ' + url.pathname;
  const now = new Date();
  const source = runSource(env, now);
  const keyConfigured = isKeyConfigured(env.GARMIN_API_KEY);

  if (route === 'GET /api/stats') return json(await buildStats(source, now, keyConfigured));
  if (route === 'GET /api/status') return json(await buildStatus(source, now, keyConfigured));
  if (route === 'GET /api/runs') {
    const wanted = new Set((url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, MAX_RUN_IDS));
    const found = (await source.runs()).filter((run) => wanted.has(String(run.id)));
    const runs = found.map((run) => describeRunDetail(run, MAX_HEART_RATE, RESTING_HEART_RATE));
    return json({ locale: LOCALE, numberLocale: NUMBER_LOCALE, maxHeartRate: MAX_HEART_RATE, restingHeartRate: RESTING_HEART_RATE, runs });
  }
  if (route === 'POST /api/refresh') {
    const { result, runs, meta } = await source.sync('manual');
    const after = new Date();
    const status = statusFrom(source, meta, await source.tokenExpiresAt(), after, keyConfigured);
    return json({ sync: result, stats: statsFrom(runs, status, after) });
  }

  if (API_PATHS.includes(url.pathname)) return json({ error: 'Method not allowed' }, 405);
  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    try {
      const gate = evaluateGate(request, env.ACCESS_TOKEN);
      if (gate.action === 'deny') return denied(gate.status);
      if (gate.action === 'redirect') {
        return new Response(null, {
          status: 302,
          headers: { Location: gate.location, 'Set-Cookie': gate.setCookie, 'Cache-Control': 'no-store' },
        });
      }
      return await handleRequest(request, env);
    } catch (err) {
      console.error('[http] ' + (err && err.message ? err.message : String(err)));
      return json({ error: 'Internal error' }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runSource(env, new Date()).sync('cron'));
  },
};
