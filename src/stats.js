export const DAY_MS = 86400000;
const MARATHON_METERS = 42195;
const MARATHON_TARGET = { key: 'marathon', label: 'Marathon', meters: MARATHON_METERS };
const CALENDAR_WEEKS = 5;
const LONG_RUN_MAX_PENALTY = 0.07;
const HR_MIN_RESERVE = 0.5;
const HR_MAX_RESERVE = 0.9;
const HR_MIN_RUNS = 3;
const VO2_AT_REST = 3.5;
const PROJECTION_TARGETS = [
  { key: '5k', label: '5K', meters: 5000 },
  { key: '10k', label: '10K', meters: 10000 },
  { key: 'half', label: 'Half marathon', meters: 21097.5 },
];
const RIEGEL_EXPONENT = 1.06;
const PROJECTION_WINDOW_DAYS = 56;
const PROJECTION_MIN_METERS = 5000;
const CONFIDENCE_WINDOW_DAYS = 42;
const CONFIDENCE_LONG_RUN_METERS = 28000;
const LONGEST_RUN_WINDOW_DAYS = 56;
const PACE_WINDOW_DAYS = 56;
const WEEKLY_CHART_WEEKS = 16;
const KEY_EXPIRY_WARN_DAYS = 14;
const KEY_EXPIRY_URGENT_DAYS = 2;
const TRAIL_TYPE_KEY = 'trail_running';
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function round(value, digits) {
  const f = Math.pow(10, digits);
  return Math.round(value * f) / f;
}

export function localDateKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return get('year') + '-' + get('month') + '-' + get('day');
}

export function dayMsFromKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key || ''));
  if (!match) return NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function dateKeyFromMs(dayMs) {
  const d = new Date(dayMs);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

export function shiftDateKey(key, days) {
  return dateKeyFromMs(dayMsFromKey(key) + days * DAY_MS);
}

export function formatDate(dayMs) {
  const d = new Date(dayMs);
  return pad2(d.getUTCDate()) + '.' + pad2(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear();
}

function formatShortDate(dayMs) {
  const d = new Date(dayMs);
  return pad2(d.getUTCDate()) + '.' + pad2(d.getUTCMonth() + 1) + '.';
}

export function parseEuropeanDate(value) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(value || '').trim());
  if (!match) return null;
  const ms = Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
  const check = new Date(ms);
  if (check.getUTCDate() !== Number(match[1]) || check.getUTCMonth() !== Number(match[2]) - 1) return null;
  return ms;
}

function startOfWeek(dayMs, weekStartDay) {
  const dow = new Date(dayMs).getUTCDay();
  return dayMs - ((dow - weekStartDay + 7) % 7) * DAY_MS;
}

export function riegelSeconds(durationSeconds, distanceMeters, targetMeters) {
  return durationSeconds * Math.pow(targetMeters / distanceMeters, RIEGEL_EXPONENT);
}

export function riegelMarathonSeconds(durationSeconds, distanceMeters) {
  return riegelSeconds(durationSeconds, distanceMeters, MARATHON_METERS);
}

export function vo2AtVelocity(metersPerMinute) {
  return -4.6 + 0.182258 * metersPerMinute + 0.000104 * metersPerMinute * metersPerMinute;
}

export function sustainableFraction(minutes) {
  return 0.8 + 0.1894393 * Math.exp(-0.012778 * minutes) + 0.2989558 * Math.exp(-0.1932605 * minutes);
}

export function vdotFromRace(meters, seconds) {
  const minutes = seconds / 60;
  return vo2AtVelocity(meters / minutes) / sustainableFraction(minutes);
}

export function raceSecondsFromVdot(vdot, meters) {
  let low = 3;
  let high = 600;
  for (let i = 0; i < 80; i++) {
    const mid = (low + high) / 2;
    if (vo2AtVelocity(meters / mid) > vdot * sustainableFraction(mid)) low = mid;
    else high = mid;
  }
  return ((low + high) / 2) * 60;
}

export function heartRateReserve(averageHr, maxHr, restingHr) {
  return (averageHr - restingHr) / (maxHr - restingHr);
}

export function vo2maxFromHeartRate(meters, seconds, averageHr, maxHr, restingHr) {
  const reserve = heartRateReserve(averageHr, maxHr, restingHr);
  return (vo2AtVelocity(meters / (seconds / 60)) - VO2_AT_REST) / reserve + VO2_AT_REST;
}

function inReserveRange(averageHr, maxHr, restingHr) {
  if (!Number.isFinite(averageHr) || !(maxHr > restingHr)) return false;
  const reserve = heartRateReserve(averageHr, maxHr, restingHr);
  return reserve >= HR_MIN_RESERVE && reserve <= HR_MAX_RESERVE;
}

function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function isUsable(activity) {
  return (
    activity &&
    typeof activity.startLocal === 'string' &&
    Number.isFinite(activity.distance) &&
    Number.isFinite(activity.duration)
  );
}

function summarize(runs, from, to) {
  let count = 0;
  let distance = 0;
  let duration = 0;
  let trailRuns = 0;
  let trailDistance = 0;
  for (const run of runs) {
    if (run.day < from || run.day >= to) continue;
    count++;
    distance += run.distance;
    duration += run.duration;
    if (run.isTrail) {
      trailRuns++;
      trailDistance += run.distance;
    }
  }
  return {
    runs: count,
    distanceKm: round(distance / 1000, 1),
    durationSeconds: Math.round(duration),
    trailRuns,
    trailKm: round(trailDistance / 1000, 1),
    avgPaceSecPerKm: distance > 0 ? Math.round(duration / (distance / 1000)) : null,
  };
}

function averageHeartRate(dayRuns) {
  let weighted = 0;
  let seconds = 0;
  for (const run of dayRuns) {
    if (!Number.isFinite(run.averageHR) || !(run.duration > 0)) continue;
    weighted += run.averageHR * run.duration;
    seconds += run.duration;
  }
  return seconds > 0 ? Math.round(weighted / seconds) : null;
}

function calendarWeeks(runs, weekStart, today) {
  const weeks = [];
  for (let i = CALENDAR_WEEKS - 1; i >= 0; i--) {
    const start = weekStart - i * 7 * DAY_MS;
    weeks.push({
      from: formatDate(start),
      to: formatDate(start + 6 * DAY_MS),
      ...summarize(runs, start, start + 7 * DAY_MS),
      days: weekDays(runs, start, today),
    });
  }
  return weeks;
}

function weekDays(runs, weekStart, today) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const day = weekStart + i * DAY_MS;
    days.push({
      date: formatDate(day),
      label: formatShortDate(day),
      weekday: WEEKDAY_NAMES[new Date(day).getUTCDay()],
      isToday: day === today,
      isFuture: day > today,
      names: runs.filter((r) => r.day === day).map((r) => r.name),
      runIds: runs.filter((r) => r.day === day).map((r) => r.id),
      averageHR: averageHeartRate(runs.filter((r) => r.day === day)),
      ...summarize(runs, day, day + DAY_MS),
    });
  }
  return days;
}

function describeRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    name: run.name,
    type: run.type,
    date: formatDate(run.day),
    distanceKm: round(run.distance / 1000, 2),
    durationSeconds: Math.round(run.duration),
    paceSecPerKm: run.distance > 0 ? Math.round(run.duration / (run.distance / 1000)) : null,
    averageHR: run.averageHR ?? null,
  };
}

function longestOf(runs) {
  let best = null;
  for (const run of runs) if (!best || run.distance > best.distance) best = run;
  return best;
}

export function isoWeekOf(dayMs) {
  const date = new Date(dayMs);
  const dow = date.getUTCDay() || 7;
  const thursday = dayMs + (4 - dow) * DAY_MS;
  const yearStart = Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1);
  return Math.ceil(((thursday - yearStart) / DAY_MS + 1) / 7);
}

export function calendarCountdown(fromMs, toMs) {
  const totalDays = Math.round((toMs - fromMs) / DAY_MS);
  if (totalDays <= 0) return { totalDays, months: 0, days: 0, weeks: 0 };
  const from = new Date(fromMs);
  const to = new Date(toMs);
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months--;
  const monthIndex = from.getUTCMonth() + months;
  const anchorYear = from.getUTCFullYear() + Math.floor(monthIndex / 12);
  const anchorMonth = monthIndex % 12;
  const lastDay = new Date(Date.UTC(anchorYear, anchorMonth + 1, 0)).getUTCDate();
  const anchor = Date.UTC(anchorYear, anchorMonth, Math.min(from.getUTCDate(), lastDay));
  return { totalDays, months, days: Math.round((toMs - anchor) / DAY_MS), weeks: Math.floor(totalDays / 7) };
}

function describeRace(race, today) {
  const raceDay = race ? parseEuropeanDate(race.date) : null;
  if (raceDay === null) return null;
  const countdown = calendarCountdown(today, raceDay);
  return {
    name: race.name,
    place: race.place,
    date: formatDate(raceDay),
    weekday: WEEKDAY_NAMES[new Date(raceDay).getUTCDay()],
    phase: countdown.totalDays > 0 ? 'upcoming' : countdown.totalDays === 0 ? 'race_day' : 'finished',
    ...countdown,
  };
}

function bestEquivalent(eligible, targetMeters) {
  let best = null;
  for (const run of eligible) {
    const seconds = riegelSeconds(run.duration, run.distance, targetMeters);
    if (!best || seconds < best.seconds) best = { seconds, run };
  }
  return best;
}

function projectionTarget(target, best) {
  return {
    key: target.key,
    label: target.label,
    distanceKm: target.meters / 1000,
    seconds: best ? Math.round(best.seconds) : null,
    paceSecPerKm: best ? Math.round(best.seconds / (target.meters / 1000)) : null,
    basis: best ? describeRun(best.run) : null,
  };
}

function heartRateProjection(eligible, maxHr, restingHr, goal, longestMeters) {
  if (!maxHr || !restingHr) return null;
  const estimates = [];
  for (const run of eligible) {
    if (!inReserveRange(run.averageHR, maxHr, restingHr)) continue;
    estimates.push(vo2maxFromHeartRate(run.distance, run.duration, run.averageHR, maxHr, restingHr));
  }
  if (estimates.length < HR_MIN_RUNS) return null;
  estimates.sort((a, b) => a - b);
  const vo2max = median(estimates);
  const shortfall = Math.min(1, Math.max(0, 1 - longestMeters / CONFIDENCE_LONG_RUN_METERS));
  const penalty = LONG_RUN_MAX_PENALTY * shortfall;
  const targets = [...PROJECTION_TARGETS, MARATHON_TARGET].map((target) => {
    const raw = raceSecondsFromVdot(vo2max, target.meters);
    const seconds = Math.round(target.key === 'marathon' ? raw * (1 + penalty) : raw);
    return {
      key: target.key,
      label: target.label,
      distanceKm: target.meters / 1000,
      seconds,
      paceSecPerKm: Math.round(seconds / (target.meters / 1000)),
    };
  });
  const marathon = targets[targets.length - 1];
  return {
    maxHeartRate: maxHr,
    restingHeartRate: restingHr,
    longestRunKm: round(longestMeters / 1000, 1),
    longRunPenaltyPercent: round(penalty * 100, 1),
    marathonFullyTrainedSeconds: Math.round(raceSecondsFromVdot(vo2max, MARATHON_METERS)),
    vo2max: round(vo2max, 1),
    runsUsed: estimates.length,
    vo2maxLow: round(estimates[Math.floor((estimates.length - 1) * 0.25)], 1),
    vo2maxHigh: round(estimates[Math.floor((estimates.length - 1) * 0.75)], 1),
    minPercentReserve: HR_MIN_RESERVE * 100,
    maxPercentReserve: HR_MAX_RESERVE * 100,
    targets,
    gapSeconds: marathon.seconds - goal.seconds,
    paceVsGoalSecPerKm: marathon.paceSecPerKm - goal.paceSecPerKm,
  };
}

function computeProjection(runs, today, goal, maxHr, restingHr) {
  const projectionStart = today - (PROJECTION_WINDOW_DAYS - 1) * DAY_MS;
  const confidenceStart = today - (CONFIDENCE_WINDOW_DAYS - 1) * DAY_MS;
  const eligible = runs.filter((r) => r.day >= projectionStart && r.distance >= PROJECTION_MIN_METERS && r.duration > 0);
  const best = bestEquivalent(eligible, MARATHON_METERS);
  const longest6w = longestOf(runs.filter((r) => r.day >= confidenceStart));
  const paceSecPerKm = best ? Math.round(best.seconds / (MARATHON_METERS / 1000)) : null;
  const riegelTargets = PROJECTION_TARGETS.map((target) => projectionTarget(target, bestEquivalent(eligible, target.meters)));
  const hr = heartRateProjection(eligible, maxHr, restingHr, goal, longest6w ? longest6w.distance : 0);
  const hrMarathon = hr ? hr.targets[hr.targets.length - 1] : null;
  let headline = null;
  if (hr) {
    headline = { method: 'heart_rate', seconds: hrMarathon.seconds, paceSecPerKm: hrMarathon.paceSecPerKm, gapSeconds: hr.gapSeconds, paceVsGoalSecPerKm: hr.paceVsGoalSecPerKm };
  } else if (best) {
    headline = { method: 'riegel', seconds: Math.round(best.seconds), paceSecPerKm, gapSeconds: Math.round(best.seconds - goal.seconds), paceVsGoalSecPerKm: paceSecPerKm - goal.paceSecPerKm };
  }
  return {
    headline,
    otherTargets: hr ? hr.targets.slice(0, PROJECTION_TARGETS.length) : riegelTargets,
    comparisonTargets: hr ? [...riegelTargets, projectionTarget(MARATHON_TARGET, best)] : null,
    seconds: best ? Math.round(best.seconds) : null,
    paceSecPerKm,
    gapSeconds: best ? Math.round(best.seconds - goal.seconds) : null,
    paceVsGoalSecPerKm: best ? paceSecPerKm - goal.paceSecPerKm : null,
    basis: best ? describeRun(best.run) : null,
    targets: riegelTargets,
    hr,
    windowWeeks: PROJECTION_WINDOW_DAYS / 7,
    minDistanceKm: PROJECTION_MIN_METERS / 1000,
    longestRun6w: describeRun(longest6w),
    confidenceWindowWeeks: CONFIDENCE_WINDOW_DAYS / 7,
    confidenceThresholdKm: CONFIDENCE_LONG_RUN_METERS / 1000,
    optimistic: !longest6w || longest6w.distance < CONFIDENCE_LONG_RUN_METERS,
  };
}

export function computeStats(activities, { now = new Date(), timezone, weekStartDay = 1, goalSeconds, race = null, maxHeartRate = null, restingHeartRate = null }) {
  const todayKey = localDateKey(now, timezone);
  const today = dayMsFromKey(todayKey);
  const goal = { seconds: goalSeconds, paceSecPerKm: Math.round(goalSeconds / (MARATHON_METERS / 1000)) };
  const runs = (activities || [])
    .filter(isUsable)
    .map((a) => ({ ...a, day: dayMsFromKey(a.startLocal), isTrail: a.type === TRAIL_TYPE_KEY }))
    .filter((r) => Number.isFinite(r.day))
    .sort((a, b) => (a.startLocal < b.startLocal ? -1 : a.startLocal > b.startLocal ? 1 : 0));

  const weekStart = startOfWeek(today, weekStartDay);
  const todayDate = new Date(today);
  const year = todayDate.getUTCFullYear();
  const month = todayDate.getUTCMonth();
  const monthStart = Date.UTC(year, month, 1);
  const nextMonthStart = Date.UTC(year, month + 1, 1);
  const yearStart = Date.UTC(year, 0, 1);
  const nextYearStart = Date.UTC(year + 1, 0, 1);

  const weekly = [];
  for (let i = WEEKLY_CHART_WEEKS - 1; i >= 0; i--) {
    const start = weekStart - i * 7 * DAY_MS;
    weekly.push({
      weekStart: formatDate(start),
      label: formatShortDate(start),
      ...summarize(runs, start, start + 7 * DAY_MS),
    });
  }

  const longestStart = today - (LONGEST_RUN_WINDOW_DAYS - 1) * DAY_MS;
  const paceStart = today - (PACE_WINDOW_DAYS - 1) * DAY_MS;
  const paceWindow = summarize(runs, paceStart, Infinity);

  return {
    generatedAt: now.toISOString(),
    today: formatDate(today),
    isoWeek: isoWeekOf(today),
    timezone,
    goal,
    race: describeRace(race, today),
    totals: {
      storedRuns: runs.length,
      firstRunDate: runs.length ? formatDate(runs[0].day) : null,
      lastRunDate: runs.length ? formatDate(runs[runs.length - 1].day) : null,
    },
    thisWeek: {
      from: formatDate(weekStart),
      to: formatDate(weekStart + 6 * DAY_MS),
      ...summarize(runs, weekStart, weekStart + 7 * DAY_MS),
      days: weekDays(runs, weekStart, today),
    },
    month: {
      label: MONTH_NAMES[month] + ' ' + year,
      ...summarize(runs, monthStart, nextMonthStart),
    },
    year: {
      label: String(year),
      ...summarize(runs, yearStart, nextYearStart),
    },
    weekly,
    calendar: calendarWeeks(runs, weekStart, today),
    longestRun8w: describeRun(longestOf(runs.filter((r) => r.day >= longestStart))),
    pace: {
      windowWeeks: PACE_WINDOW_DAYS / 7,
      avgSecPerKm: paceWindow.avgPaceSecPerKm,
      vsGoalSecPerKm: paceWindow.avgPaceSecPerKm === null ? null : paceWindow.avgPaceSecPerKm - goal.paceSecPerKm,
    },
    projection: computeProjection(runs, today, goal, maxHeartRate, restingHeartRate),
  };
}

function optionalFields(run, maxHr, restingHr) {
  const detail = {};
  const copy = (key, value) => {
    if (value !== null && value !== undefined) detail[key] = value;
  };
  copy('movingSeconds', run.movingDuration === undefined ? undefined : Math.round(run.movingDuration));
  copy('elevationGain', run.elevationGain);
  copy('elevationLoss', run.elevationLoss);
  copy('averageHR', run.averageHR);
  copy('maxHR', run.maxHR);
  copy('cadence', run.cadence);
  copy('strideLengthCm', run.strideLength);
  copy('calories', run.calories);
  copy('vo2maxGarmin', run.vo2max);
  copy('locationName', run.locationName);
  if (Number.isFinite(run.averageHR) && maxHr) {
    detail.percentMaxHr = Math.round((run.averageHR / maxHr) * 100);
    if (restingHr && inReserveRange(run.averageHR, maxHr, restingHr)) {
      detail.percentReserve = Math.round(heartRateReserve(run.averageHR, maxHr, restingHr) * 100);
      detail.vo2maxFromHeartRate = round(vo2maxFromHeartRate(run.distance, run.duration, run.averageHR, maxHr, restingHr), 1);
    }
  }
  return detail;
}

export function describeRunDetail(run, maxHr, restingHr) {
  const day = dayMsFromKey(run.startLocal);
  const km = run.distance / 1000;
  return {
    id: run.id,
    name: run.name,
    type: run.type,
    weekday: WEEKDAY_NAMES[new Date(day).getUTCDay()],
    date: formatDate(day),
    time: String(run.startLocal).slice(11, 16),
    distanceKm: round(km, 2),
    durationSeconds: Math.round(run.duration),
    paceSecPerKm: km > 0 ? Math.round(run.duration / km) : null,
    ...optionalFields(run, maxHr, restingHr),
  };
}

export function keyExpiryInfo(expires, { now = new Date(), timezone, warnDays = KEY_EXPIRY_WARN_DAYS }) {
  if (!expires) return { configured: false };
  const expiryMs = parseEuropeanDate(expires);
  if (expiryMs === null) return { configured: true, valid: false, raw: String(expires) };
  const today = dayMsFromKey(localDateKey(now, timezone));
  const daysLeft = Math.round((expiryMs - today) / DAY_MS);
  return {
    configured: true,
    valid: true,
    date: formatDate(expiryMs),
    daysLeft,
    expired: daysLeft < 0,
    warn: daysLeft >= 0 && daysLeft <= warnDays,
    urgent: daysLeft >= 0 && daysLeft <= KEY_EXPIRY_URGENT_DAYS,
    warnDays,
  };
}
