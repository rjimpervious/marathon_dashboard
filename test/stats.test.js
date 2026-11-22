import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  computeStats,
  calendarCountdown,
  isoWeekOf,
  keyExpiryInfo,
  localDateKey,
  shiftDateKey,
  riegelMarathonSeconds,
  riegelSeconds,
  vdotFromRace,
  raceSecondsFromVdot,
  vo2maxFromHeartRate,
  describeRunDetail,
} from '../src/stats.js';

const seed = JSON.parse(readFileSync(new URL('../seed/sample-activities.json', import.meta.url), 'utf8'));
const now = new Date('2026-11-21T12:00:00Z');
const timezone = 'Europe/Berlin';
const race = { name: 'Linz Marathon 2027', date: '11.04.2027', place: 'Linz, Austria' };
const options = { now, timezone, weekStartDay: 1, goalSeconds: 14400, race };

describe('computeStats on the seed data', () => {
  let stats;
  before(() => {
    stats = computeStats(seed, options);
  });

  it('reports today and iso week', () => {
    assert.equal(stats.today, '21.11.2026');
    assert.equal(stats.isoWeek, 47);
  });

  it('computes the goal', () => {
    assert.deepEqual(stats.goal, { seconds: 14400, paceSecPerKm: 341 });
  });

  it('summarizes this week', () => {
    assert.equal(stats.thisWeek.from, '16.11.2026');
    assert.equal(stats.thisWeek.to, '22.11.2026');
    assert.equal(stats.thisWeek.runs, 2);
    assert.equal(stats.thisWeek.distanceKm, 17.6);
    assert.equal(stats.thisWeek.trailRuns, 1);
  });

  it('lists the days of this week', () => {
    const days = stats.thisWeek.days;
    assert.deepEqual(days.map((d) => d.weekday), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    assert.deepEqual(days.map((d) => d.distanceKm), [0, 8.2, 0, 9.4, 0, 0, 0]);
    assert.deepEqual(days.map((d) => d.isToday), [false, false, false, false, false, true, false]);
  });

  it('summarizes the month', () => {
    assert.equal(stats.month.label, 'November 2026');
    assert.equal(stats.month.runs, 7);
    assert.equal(stats.month.distanceKm, 93.5);
    assert.equal(stats.month.trailKm, 27.3);
  });

  it('summarizes the year', () => {
    assert.equal(stats.year.runs, 40);
    assert.equal(stats.year.distanceKm, 465.9);
    assert.equal(stats.year.trailKm, 73.6);
  });

  it('builds the weekly series', () => {
    assert.equal(stats.weekly.length, 16);
    const last = stats.weekly[stats.weekly.length - 1];
    assert.equal(last.weekStart, '16.11.2026');
    assert.equal(last.runs, 2);
    assert.equal(last.distanceKm, 17.6);
    assert.equal(last.avgPaceSecPerKm, 416);
  });

  it('finds the longest run of the last 8 weeks', () => {
    assert.equal(stats.longestRun8w.date, '07.11.2026');
    assert.equal(stats.longestRun8w.distanceKm, 24.3);
    assert.equal(stats.longestRun8w.durationSeconds, 9291);
  });

  it('computes the pace window', () => {
    assert.equal(stats.pace.windowWeeks, 8);
    assert.equal(stats.pace.avgSecPerKm, 389);
    assert.equal(stats.pace.vsGoalSecPerKm, 48);
  });

  it('computes the projection', () => {
    const p = stats.projection;
    assert.equal(p.seconds, 14629);
    assert.equal(p.paceSecPerKm, 347);
    assert.equal(p.gapSeconds, 229);
    assert.equal(p.paceVsGoalSecPerKm, 6);
    assert.equal(p.basis.date, '29.10.2026');
    assert.equal(p.basis.distanceKm, 10);
    assert.equal(p.longestRun6w.distanceKm, 24.3);
    assert.equal(p.optimistic, true);
  });

  it('projects 5K, 10K and half marathon from the best eligible run', () => {
    const targets = stats.projection.targets;
    assert.deepEqual(targets.map((t) => t.key), ['5k', '10k', 'half']);
    assert.deepEqual(targets.map((t) => t.label), ['5K', '10K', 'Half marathon']);
    assert.deepEqual(targets.map((t) => t.distanceKm), [5, 10, 21.0975]);
    assert.deepEqual(targets.map((t) => t.seconds), [1525, 3180, 7016]);
    assert.deepEqual(targets.map((t) => t.paceSecPerKm), [305, 318, 333]);
    for (const t of targets) {
      assert.equal(t.basis.date, '29.10.2026');
      assert.equal(t.basis.distanceKm, 10);
    }
  });

  it('computes the race countdown', () => {
    const r = stats.race;
    assert.equal(r.phase, 'upcoming');
    assert.equal(r.totalDays, 141);
    assert.equal(r.months, 4);
    assert.equal(r.days, 21);
    assert.equal(r.weeks, 20);
    assert.equal(r.weekday, 'Sun');
    assert.equal(r.date, '11.04.2027');
  });

  it('reports totals', () => {
    assert.deepEqual(stats.totals, { storedRuns: 40, firstRunDate: '04.08.2026', lastRunDate: '19.11.2026' });
  });
});

describe('heart rate projection', () => {
  const withHr = (maxHeartRate, restingHeartRate = 55) => computeStats(seed, { ...options, maxHeartRate, restingHeartRate }).projection.hr;

  it('is absent without a max heart rate', () => {
    assert.equal(withHr(null), null);
  });

  it('is absent without a resting heart rate', () => {
    assert.equal(withHr(207, null), null);
  });

  it('projects from the median fitness estimate of the eligible runs', () => {
    const hr = withHr(207);
    assert.equal(hr.runsUsed, 20);
    assert.equal(hr.vo2max, 43.1);
    assert.equal(hr.restingHeartRate, 55);
    assert.deepEqual(hr.targets.map((t) => t.key), ['5k', '10k', 'half', 'marathon']);
    assert.deepEqual(hr.targets.map((t) => t.seconds), [1358, 2817, 6245, 13079]);
    assert.deepEqual(hr.targets.map((t) => t.paceSecPerKm), [272, 282, 296, 310]);
    assert.equal(hr.gapSeconds, -1321);
    assert.equal(hr.paceVsGoalSecPerKm, -31);
  });

  it('makes the heart-rate marathon the headline and keeps Riegel for comparison', () => {
    const p = computeStats(seed, { ...options, maxHeartRate: 207, restingHeartRate: 55 }).projection;
    assert.deepEqual(p.headline, { method: 'heart_rate', seconds: 13079, paceSecPerKm: 310, gapSeconds: -1321, paceVsGoalSecPerKm: -31 });
    assert.deepEqual(p.otherTargets.map((t) => t.seconds), [1358, 2817, 6245]);
    assert.deepEqual(p.comparisonTargets.map((t) => t.seconds), [1525, 3180, 7016, 14629]);
  });

  it('falls back to Riegel as the headline without heart rate settings', () => {
    const p = computeStats(seed, options).projection;
    assert.equal(p.headline.method, 'riegel');
    assert.equal(p.headline.seconds, 14629);
    assert.deepEqual(p.otherTargets.map((t) => t.seconds), [1525, 3180, 7016]);
    assert.equal(p.comparisonTargets, null);
  });

  it('has no headline without runs', () => {
    assert.equal(computeStats([], options).projection.headline, null);
  });

  it('slows only the marathon when the longest recent run is short', () => {
    const hr = withHr(207);
    assert.equal(hr.longestRunKm, 24.3);
    assert.equal(hr.longRunPenaltyPercent, 0.9);
    assert.equal(hr.marathonFullyTrainedSeconds, 12960);
    assert.equal(hr.targets[3].seconds, 13079);
    assert.deepEqual(hr.targets.slice(0, 3).map((t) => t.seconds), [1358, 2817, 6245]);
  });

  const steady = (extra) => [1, 2, 3].map((n) => ({ id: 10 + n, name: 'r' + n, type: 'running', startLocal: '2026-11-1' + n + ' 08:00:00', distance: 6000, duration: 2400, averageHR: 150 })).concat(extra);

  it('adds no penalty once a long run reaches 28 km', () => {
    const long = { id: 1, name: 'long', type: 'running', startLocal: '2026-11-15 08:00:00', distance: 30000, duration: 10800, averageHR: 150 };
    const hr = computeStats(steady([long]), { ...options, maxHeartRate: 207, restingHeartRate: 55 }).projection.hr;
    assert.equal(hr.longRunPenaltyPercent, 0);
    assert.equal(hr.targets[3].seconds, hr.marathonFullyTrainedSeconds);
  });

  it('scales the penalty with how far the longest run falls short of 28 km', () => {
    const hr = computeStats(steady([]), { ...options, maxHeartRate: 207, restingHeartRate: 55 }).projection.hr;
    assert.equal(hr.longestRunKm, 6);
    assert.equal(hr.longRunPenaltyPercent, 5.5);
    assert.equal(hr.targets[3].seconds, Math.round(hr.marathonFullyTrainedSeconds * 1.055));
  });

  it('a higher resting heart rate gives faster projections', () => {
    assert.ok(withHr(207, 70).targets[0].seconds < withHr(207, 45).targets[0].seconds);
  });

  it('needs at least three runs in the heart rate range', () => {
    assert.equal(withHr(400), null);
  });
});

describe('calendar and day heart rate', () => {
  const stats = computeStats(seed, options);

  it('covers the last five weeks, ending with this week', () => {
    assert.equal(stats.calendar.length, 5);
    assert.equal(stats.calendar[0].from, '19.10.2026');
    assert.equal(stats.calendar[4].from, stats.thisWeek.from);
    assert.equal(stats.calendar[4].to, '22.11.2026');
    assert.ok(stats.calendar.every((week) => week.days.length === 7));
  });

  it('matches the weekly chart week by week', () => {
    const tail = stats.weekly.slice(stats.weekly.length - 5);
    assert.deepEqual(stats.calendar.map((w) => w.distanceKm), tail.map((w) => w.distanceKm));
    assert.deepEqual(stats.calendar.map((w) => w.runs), tail.map((w) => w.runs));
  });

  it('weights a day heart rate by duration and leaves rest days empty', () => {
    const runs = [
      { id: 1, name: 'a', type: 'running', startLocal: '2026-11-19 07:00:00', distance: 5000, duration: 1000, averageHR: 140 },
      { id: 2, name: 'b', type: 'running', startLocal: '2026-11-19 18:00:00', distance: 9000, duration: 3000, averageHR: 160 },
    ];
    const days = computeStats(runs, options).thisWeek.days;
    assert.equal(days[3].averageHR, 155);
    assert.deepEqual(days[3].runIds, [1, 2]);
    assert.equal(days[2].averageHR, null);
  });
});

describe('describeRunDetail', () => {
  const run = { id: 7, name: 'Tempo', type: 'running', startLocal: '2026-11-19 18:20:15', distance: 9400, duration: 4277, averageHR: 150, maxHR: 171, cadence: 168 };

  it('derives pace, date and heart rate figures', () => {
    const d = describeRunDetail(run, 207, 55);
    assert.equal(d.date, '19.11.2026');
    assert.equal(d.weekday, 'Thu');
    assert.equal(d.time, '18:20');
    assert.equal(d.distanceKm, 9.4);
    assert.equal(d.paceSecPerKm, 455);
    assert.equal(d.percentMaxHr, 72);
    assert.equal(d.percentReserve, 63);
    assert.equal(d.vo2maxFromHeartRate, 31.9);
    assert.equal('hrZones' in d, false);
  });

  it('leaves out what Garmin did not send', () => {
    const d = describeRunDetail({ id: 8, name: 'Plain', type: 'running', startLocal: '2026-11-18 07:00:00', distance: 5000, duration: 1800 }, 207, 55);
    for (const key of ['averageHR', 'maxHR', 'cadence', 'percentMaxHr', 'percentReserve', 'vo2maxFromHeartRate', 'locationName']) {
      assert.equal(key in d, false, key);
    }
  });

  it('skips the fitness estimate for very easy heart rates', () => {
    const d = describeRunDetail({ ...run, averageHR: 120 }, 207, 55);
    assert.equal(d.percentMaxHr, 58);
    assert.equal('percentReserve' in d, false);
    assert.equal('vo2maxFromHeartRate' in d, false);
  });
});

describe('computeStats race handling', () => {
  it('returns null without a race', () => {
    assert.equal(computeStats(seed, { ...options, race: null }).race, null);
  });

  it('returns null for an empty race date', () => {
    assert.equal(computeStats(seed, { ...options, race: { ...race, date: '' } }).race, null);
  });

  it('detects race day', () => {
    assert.equal(computeStats(seed, { ...options, race: { ...race, date: '21.11.2026' } }).race.phase, 'race_day');
  });

  it('detects a finished race', () => {
    assert.equal(computeStats(seed, { ...options, race: { ...race, date: '01.11.2026' } }).race.phase, 'finished');
  });
});

describe('computeStats without runs', () => {
  it('returns empty aggregates', () => {
    const stats = computeStats([], options);
    assert.equal(stats.thisWeek.runs, 0);
    assert.equal(stats.projection.seconds, null);
    assert.equal(stats.projection.optimistic, true);
    assert.deepEqual(stats.projection.targets.map((t) => t.seconds), [null, null, null]);
    assert.deepEqual(stats.projection.targets.map((t) => t.basis), [null, null, null]);
    assert.equal(stats.longestRun8w, null);
    assert.equal(stats.pace.avgSecPerKm, null);
    assert.equal(stats.pace.vsGoalSecPerKm, null);
  });
});

describe('calendarCountdown', () => {
  it('clamps at month end', () => {
    assert.deepEqual(calendarCountdown(Date.UTC(2027, 0, 31), Date.UTC(2027, 2, 1)), {
      totalDays: 29,
      months: 1,
      days: 1,
      weeks: 4,
    });
  });

  it('handles the same day', () => {
    assert.equal(calendarCountdown(Date.UTC(2027, 0, 31), Date.UTC(2027, 0, 31)).totalDays, 0);
  });

  it('handles a past date', () => {
    const result = calendarCountdown(Date.UTC(2027, 2, 1), Date.UTC(2027, 0, 31));
    assert.ok(result.totalDays < 0);
    assert.equal(result.months, 0);
    assert.equal(result.days, 0);
    assert.equal(result.weeks, 0);
  });
});

describe('isoWeekOf', () => {
  it('handles year boundaries', () => {
    assert.equal(isoWeekOf(Date.UTC(2027, 0, 1)), 53);
    assert.equal(isoWeekOf(Date.UTC(2025, 11, 29)), 1);
  });

  it('computes a regular week', () => {
    assert.equal(isoWeekOf(Date.UTC(2026, 10, 21)), 47);
  });
});

describe('keyExpiryInfo', () => {
  it('warns at 14 days', () => {
    const info = keyExpiryInfo('05.12.2026', { now, timezone });
    assert.equal(info.daysLeft, 14);
    assert.equal(info.warn, true);
    assert.equal(info.expired, false);
  });

  it('is urgent from 2 days before expiry, not before', () => {
    assert.equal(keyExpiryInfo('23.11.2026', { now, timezone }).urgent, true);
    assert.equal(keyExpiryInfo('24.11.2026', { now, timezone }).urgent, false);
    assert.equal(keyExpiryInfo('21.11.2026', { now, timezone }).urgent, true);
    assert.equal(keyExpiryInfo('20.11.2026', { now, timezone }).urgent, false);
    assert.equal(keyExpiryInfo('20.11.2027', { now, timezone }).daysLeft, 364);
  });

  it('handles an empty value', () => {
    assert.deepEqual(keyExpiryInfo('', { now, timezone }), { configured: false });
  });

  it('handles an invalid date', () => {
    assert.deepEqual(keyExpiryInfo('31.02.2027', { now, timezone }), {
      configured: true,
      valid: false,
      raw: '31.02.2027',
    });
  });

  it('detects an expired date', () => {
    const info = keyExpiryInfo('01.11.2026', { now, timezone });
    assert.equal(info.expired, true);
    assert.equal(info.warn, false);
  });
});

describe('date and pace helpers', () => {
  it('localDateKey applies the timezone', () => {
    assert.equal(localDateKey(new Date('2026-11-21T23:30:00Z'), 'Europe/Berlin'), '2026-11-22');
  });

  it('riegelMarathonSeconds projects a marathon time', () => {
    assert.equal(Math.round(riegelMarathonSeconds(3180, 10000)), 14629);
  });

  it('riegelSeconds keeps the time at the same distance', () => {
    assert.equal(riegelSeconds(3180, 10000, 10000), 3180);
  });

  it('riegelSeconds matches riegelMarathonSeconds for the marathon', () => {
    assert.equal(riegelSeconds(3180, 10000, 42195), riegelMarathonSeconds(3180, 10000));
  });

  it('riegelSeconds predicts a faster time for a shorter distance', () => {
    assert.ok(riegelSeconds(3180, 10000, 5000) < 3180 / 1.9);
    assert.ok(riegelSeconds(3180, 10000, 5000) > 3180 / 2.1);
  });

  it('vdotFromRace matches the published Daniels values', () => {
    assert.equal(vdotFromRace(5000, 1200).toFixed(1), '49.8');
    assert.equal(vdotFromRace(10000, 2400).toFixed(1), '51.9');
  });

  it('raceSecondsFromVdot inverts vdotFromRace', () => {
    for (const [meters, seconds] of [[5000, 1500], [10000, 3180], [21097.5, 7016], [42195, 14400]]) {
      const back = raceSecondsFromVdot(vdotFromRace(meters, seconds), meters);
      assert.ok(Math.abs(back - seconds) < 1, meters + ' m: ' + back);
    }
  });

  it('a fitter runner gets faster projections at every distance', () => {
    for (const meters of [5000, 10000, 21097.5, 42195]) {
      assert.ok(raceSecondsFromVdot(50, meters) < raceSecondsFromVdot(40, meters));
    }
  });

  it('vo2maxFromHeartRate estimates a higher ceiling for the same pace at a lower heart rate', () => {
    const easy = vo2maxFromHeartRate(10000, 3600, 140, 207, 55);
    const hard = vo2maxFromHeartRate(10000, 3600, 170, 207, 55);
    assert.ok(easy > hard);
    assert.equal(vo2maxFromHeartRate(10000, 3600, 150, 207, 55).toFixed(1), '43.8');
  });

  it('shiftDateKey moves across month boundaries', () => {
    assert.equal(shiftDateKey('2026-03-01', -3), '2026-02-26');
  });
});
