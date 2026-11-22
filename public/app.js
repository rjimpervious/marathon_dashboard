import { formatDuration, formatPace } from './format.js';

const REFRESH_LABEL = 'Refresh now';
const SYNCING_LABEL = 'Syncing…';

var LOCALE = 'de-DE';
var NUMBER_LOCALE = 'en-GB';
var TIMEZONE = 'Europe/Berlin';
var charts = {};
var current = null;
var CHART_FONT_STEPS = [[1900, 15], [1400, 13], [0, 11]];

function chartFontSize() {
  for (var i = 0; i < CHART_FONT_STEPS.length; i++) {
    if (window.innerWidth >= CHART_FONT_STEPS[i][0]) return CHART_FONT_STEPS[i][1];
  }
  return 11;
}

function byId(id) { return document.getElementById(id); }
function setText(id, text) { byId(id).textContent = text; }
function num(value, digits) {
  return Number(value || 0).toLocaleString(NUMBER_LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function dateTime(iso) {
  if (!iso) return 'never';
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: TIMEZONE, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(new Date(iso));
}
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
function daysText(n) { return n === 0 ? 'today' : plural(n, 'day') + ' left'; }
function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}
function setValue(id, value, unit) {
  var node = byId(id);
  node.textContent = value;
  if (unit) node.appendChild(el('small', null, unit));
}
function paceVsGoal(diffSecPerKm) {
  if (diffSecPerKm === null || diffSecPerKm === undefined) return '';
  if (diffSecPerKm === 0) return 'Exactly on goal pace';
  return formatPace(Math.abs(diffSecPerKm)) + ' /km ' + (diffSecPerKm > 0 ? 'slower' : 'faster') + ' than goal pace';
}

function renderHeader(d) {
  var line = byId('sysline');
  line.textContent = '';
  [['Date', d.today], ['KW', String(d.isoWeek)], ['TZ', d.timezone]].forEach(function (pair, i) {
    if (i) line.appendChild(document.createTextNode('  //  '));
    line.appendChild(document.createTextNode(pair[0] + ' '));
    line.appendChild(el('b', null, pair[1]));
  });
  setText('week-number', '// KW ' + d.isoWeek);
}

function renderCountdown(d) {
  var race = d.race;
  byId('countdown').hidden = !race;
  if (!race) return;
  setText('race-name', race.name);
  var meta = byId('race-meta');
  meta.textContent = '';
  meta.appendChild(el('b', null, race.weekday + ' ' + race.date));
  meta.appendChild(document.createTextNode(' · ' + race.place + ' · goal '));
  meta.appendChild(el('span', 'goal', formatDuration(d.goal.seconds)));
  meta.appendChild(document.createTextNode(' at ' + formatPace(d.goal.paceSecPerKm) + ' /km'));

  var clock = byId('clock');
  clock.textContent = '';
  function unit(value, label, colorClass) {
    var box = el('div', 'unit');
    box.appendChild(el('div', 'num ' + colorClass, String(value)));
    box.appendChild(el('div', 'txt', label));
    clock.appendChild(box);
  }
  if (race.phase === 'upcoming') {
    unit(race.months, race.months === 1 ? 'Month' : 'Months', 'c-cyan');
    unit(race.days, race.days === 1 ? 'Day' : 'Days', 'c-green');
    setText('clock-total', num(race.totalDays, 0) + ' days · ' + race.weeks + ' weeks to go');
  } else if (race.phase === 'race_day') {
    unit('GO', 'Race day', 'c-green');
    setText('clock-total', 'Today is race day');
  } else {
    unit('✓', 'Finished', 'c-violet');
    setText('clock-total', plural(-race.totalDays, 'day') + ' since race day');
  }
}

function renderKeyChip(d) {
  var chip = byId('key-chip');
  var s = d.status;
  var e = s.keyExpiry || {};
  var state = 'ok';
  var text;
  if (s.lastStatus === 'key_invalid') {
    state = 'bad';
    text = 'Garmin key invalid or expired';
  } else if (!e.configured || e.valid === false) {
    text = 'Key expiry not set';
  } else if (e.expired) {
    state = 'bad';
    text = 'Garmin key expired on ' + e.date;
  } else if (e.urgent) {
    state = 'bad';
    text = 'Renew Garmin key · ' + daysText(e.daysLeft);
  } else if (e.warn) {
    state = 'warn';
    text = 'Garmin key expires in ' + plural(e.daysLeft, 'day');
  } else {
    text = 'Garmin key valid · ' + plural(e.daysLeft, 'day') + ' left';
  }
  chip.hidden = false;
  chip.className = 'key-chip ' + state;
  chip.textContent = text;
  chip.title = e.date ? 'Expires ' + e.date : 'Set GARMIN_KEY_EXPIRES in src/config.js';
}

function renderBanners(d) {
  var box = byId('banners');
  var s = d.status;
  box.textContent = '';
  function add(kind, title, body) {
    var node = el('div', 'banner ' + kind);
    node.appendChild(el('strong', null, title));
    if (body) node.appendChild(document.createTextNode(' ' + body));
    box.appendChild(node);
  }
  var expiry = s.keyExpiry || {};
  if (s.source === 'sample') add('info', 'Sample data.', 'USE_SAMPLE_DATA is true in src/config.js, so Garmin is not called.');
  if (s.source === 'garmin' && !s.keyConfigured) add('error', 'No Garmin key configured.', 'Set GARMIN_API_KEY in src/config.js.');
  if (s.lastStatus === 'key_invalid' || expiry.expired) {
    add('error', 'Garmin key invalid or expired.', 'Create a new Personal API key in Garmin Connect, put it in src/config.js and update GARMIN_KEY_EXPIRES.' + (s.lastError ? ' (' + s.lastError.message + ')' : ''));
  } else if (expiry.urgent) {
    add('error', 'Renew your Garmin key now.', 'It expires on ' + expiry.date + ' (' + daysText(expiry.daysLeft) + '). Create a new key in Garmin Connect, put it in src/config.js, update GARMIN_KEY_EXPIRES and deploy.');
  } else if (expiry.warn) {
    add('warn', 'Garmin key expires soon.', 'It expires on ' + expiry.date + ' (' + daysText(expiry.daysLeft) + '). Create a new key before then.');
  }
  if (expiry.configured && expiry.valid === false) add('warn', 'GARMIN_KEY_EXPIRES is not a valid date.', 'Use the format DD.MM.YYYY.');
  if (s.lastStatus === 'rate_limited') add('warn', 'Garmin rate limit reached.', s.blockedUntil ? 'The next sync runs after ' + dateTime(s.blockedUntil) + '.' : '');
  if (s.lastStatus === 'network_error' || s.lastStatus === 'error') add('warn', 'Last sync failed.', s.lastError ? s.lastError.message : '');
  if (s.lastStatus === 'partial') add('info', 'History is still loading.', 'The remaining runs are fetched on the next sync.');
  if (s.lastStatus === 'never_synced' && s.keyConfigured) add('info', 'No data yet.', 'Press "Refresh now" to run the first sync.');
}

function renderWeek(d) {
  var w = d.thisWeek;
  var total = byId('week-total');
  total.textContent = '';
  total.appendChild(el('b', null, num(w.distanceKm, 1) + ' km'));
  total.appendChild(document.createTextNode(' · ' + plural(w.runs, 'run') + (w.runs ? ' · ' + formatDuration(w.durationSeconds) : '') + (w.trailRuns ? ' · ' + w.trailRuns + ' trail' : '') + ' · ' + w.from + ' – ' + w.to));

  var box = byId('days');
  box.textContent = '';
  var days = w.days || [];
  var maxKm = Math.max.apply(null, days.map(function (x) { return x.distanceKm; }).concat([1]));
  var latestIndex = -1;
  days.forEach(function (x, i) {
    if (x.runs) latestIndex = i;
  });
  days.forEach(function (day, index) {
    var isLatest = index === latestIndex;
    var classes = ['day'];
    if (isLatest) classes.push('latest');
    if (day.isToday) classes.push('today');
    if (day.isFuture) classes.push('future');
    if (day.runs) classes.push('has-run');
    if (day.trailRuns) classes.push('trail');
    var linked = day.runIds && day.runIds.length > 0;
    var tile = el(linked ? 'a' : 'article', classes.join(' '));
    if (linked) tile.href = '/run.html?ids=' + day.runIds.join(',');
    if (day.names && day.names.length) tile.title = day.names.join(' · ');
    tile.setAttribute('aria-label', day.weekday + ' ' + day.date + ': ' + (day.runs ? num(day.distanceKm, 1) + ' km in ' + plural(day.runs, 'run') : 'no run') + (linked ? ', open details' : ''));

    var head = el('div', 'day-head');
    var name = el('span', 'dow-wrap');
    name.appendChild(el('span', 'dow', day.weekday));
    if (isLatest) name.appendChild(el('span', 'live-dot'));
    if (day.isToday || isLatest) name.appendChild(el('span', 'tag ' + (day.isToday ? 'today' : 'latest'), day.isToday ? 'Today' : 'Latest'));
    head.appendChild(name);
    head.appendChild(el('span', 'dd', day.label));
    tile.appendChild(head);

    var km = el('div', 'day-km' + (day.runs ? '' : ' empty'));
    if (day.runs) {
      km.textContent = num(day.distanceKm, 1);
      km.appendChild(el('small', null, 'km'));
    } else {
      km.textContent = '—';
    }
    tile.appendChild(km);

    var meta = el('div', 'day-meta');
    if (day.runs) {
      meta.appendChild(el('span', 'line', plural(day.runs, 'run') + ' · ' + formatDuration(day.durationSeconds)));
      meta.appendChild(el('span', 'line', formatPace(day.avgPaceSecPerKm) + ' /km'));
      if (day.averageHR) meta.appendChild(el('span', 'line hr', 'HR ' + day.averageHR + ' bpm'));
    } else {
      meta.appendChild(el('span', 'line', day.isFuture ? 'Upcoming' : day.isToday ? 'No run yet' : 'Rest day'));
    }
    if (day.trailRuns) {
      var tags = el('span', 'tags');
      tags.appendChild(el('span', 'tag trail', 'Trail'));
      meta.appendChild(tags);
    }
    tile.appendChild(meta);

    var bar = el('div', 'day-bar');
    var fill = el('span');
    fill.style.width = (day.runs ? Math.max(6, Math.round((day.distanceKm / maxKm) * 100)) : 0) + '%';
    bar.appendChild(fill);
    tile.appendChild(bar);
    box.appendChild(tile);
  });
}

function renderKpis(d) {
  var week = d.thisWeek;
  var lastWeek = d.weekly[d.weekly.length - 2];
  setValue('week-km', num(week.distanceKm, 1), 'km');
  var delta = lastWeek ? Math.round((week.distanceKm - lastWeek.distanceKm) * 10) / 10 : null;
  setText('week-km-note', plural(week.runs, 'run') + (week.runs ? ' · ' + formatDuration(week.durationSeconds) : '') + (delta === null ? '' : ' · ' + (delta >= 0 ? '+' : '−') + num(Math.abs(delta), 1) + ' km vs last week'));
  setValue('year-km', num(d.year.distanceKm, 0), 'km');
  setText('year-km-note', d.year.label + ' · ' + plural(d.year.runs, 'run') + (d.year.trailKm ? ' · ' + num(d.year.trailKm, 1) + ' km trail' : ''));
  var longest = d.longestRun8w;
  if (longest) {
    setValue('longest-km', num(longest.distanceKm, 1), 'km');
    setText('longest-note', longest.date + ' · ' + formatDuration(longest.durationSeconds) + ' · ' + longest.name);
  } else {
    setValue('longest-km', '–');
    setText('longest-note', 'No runs in the last 8 weeks');
  }
  if (d.pace.avgSecPerKm) {
    setValue('avg-pace', formatPace(d.pace.avgSecPerKm), '/km');
    setText('avg-pace-note', paceVsGoal(d.pace.vsGoalSecPerKm));
  } else {
    setValue('avg-pace', '–');
    setText('avg-pace-note', 'No runs in the last ' + d.pace.windowWeeks + ' weeks');
  }
}

function longRunNote(hr, p) {
  if (!hr.longRunPenaltyPercent) return '';
  return 'The marathon time includes +' + num(hr.longRunPenaltyPercent, 1) + '% because your longest recent run is ' + num(hr.longestRunKm, 1) + ' km; the extra time fades to zero at ' + p.confidenceThresholdKm + ' km. Trained for the distance it would be ' + formatDuration(hr.marathonFullyTrainedSeconds) + '. ';
}

function renderTargetTiles(container, targets, tone) {
  container.textContent = '';
  targets.forEach(function (t) {
    var box = el('div', 'target');
    box.appendChild(el('div', 't-label', t.label));
    box.appendChild(el('div', 't-time ' + tone, t.seconds ? formatDuration(t.seconds) : '–'));
    box.appendChild(el('div', 't-pace', t.paceSecPerKm ? formatPace(t.paceSecPerKm) + ' /km' : ''));
    if (t.basis) box.title = 'Based on "' + t.basis.name + '" on ' + t.basis.date + ': ' + num(t.basis.distanceKm, 2) + ' km in ' + formatDuration(t.basis.durationSeconds);
    container.appendChild(box);
  });
}

function renderProjection(d) {
  var p = d.projection;
  var h = p.headline;
  var hr = p.hr;
  var byHeartRate = Boolean(h && h.method === 'heart_rate');
  setText('proj-label', 'Marathon projection · ' + (byHeartRate ? 'heart rate' : 'Riegel (pace only)'));
  setText('proj-time', h ? formatDuration(h.seconds) : '–');
  setText('goal-time', formatDuration(d.goal.seconds));
  setText('goal-pace', formatPace(d.goal.paceSecPerKm));
  setValue('proj-pace', h ? formatPace(h.paceSecPerKm) : '–', h ? '/km' : '');
  setText('pace-diff', h ? paceVsGoal(h.paceVsGoalSecPerKm) : '');
  var gap = byId('proj-gap');
  if (!h) {
    gap.textContent = '';
    gap.className = 'gap';
  } else if (h.gapSeconds > 0) {
    gap.textContent = '+' + formatDuration(h.gapSeconds) + ' slower than goal';
    gap.className = 'gap c-red';
  } else {
    gap.textContent = '−' + formatDuration(-h.gapSeconds) + ' faster than goal';
    gap.className = 'gap c-green';
  }
  if (byHeartRate) {
    setText('proj-basis', longRunNote(hr, p) + 'Fitness estimate (VO2max) ' + num(hr.vo2max, 1) + ', typical range ' + num(hr.vo2maxLow, 1) + '–' + num(hr.vo2maxHigh, 1) + ', from ' + hr.runsUsed + ' runs at ' + hr.minPercentReserve + '–' + hr.maxPercentReserve + '% of your heart rate reserve (max ' + hr.maxHeartRate + ', resting ' + hr.restingHeartRate + '). It assumes your real max heart rate is ' + hr.maxHeartRate + '; if it is lower, these times are too fast. It is an estimate from training runs, not race effort.');
  } else if (p.basis) {
    setText('proj-basis', 'Based on "' + p.basis.name + '" on ' + p.basis.date + ': ' + num(p.basis.distanceKm, 2) + ' km in ' + formatDuration(p.basis.durationSeconds) + ' (' + formatPace(p.basis.paceSecPerKm) + ' /km). Best of all runs ≥ ' + p.minDistanceKm + ' km in the last ' + p.windowWeeks + ' weeks.');
  } else {
    setText('proj-basis', 'No run of at least ' + p.minDistanceKm + ' km in the last ' + p.windowWeeks + ' weeks.');
  }
  setText('others-label', 'Other distances · ' + (byHeartRate ? 'heart rate' : 'Riegel'));
  renderTargetTiles(byId('targets'), p.otherTargets || [], byHeartRate ? 'c-green' : 'c-cyan');
  var compare = p.comparisonTargets;
  byId('compare-wrap').hidden = !compare;
  if (compare) {
    renderTargetTiles(byId('compare-targets'), compare, 'c-cyan');
    setText('compare-note', 'Uses only the pace of your single best run, so mostly easy training runs make it too slow. Shown for comparison.');
  }
  var conf = byId('confidence');
  var longest = p.longestRun6w;
  if (p.optimistic) {
    conf.className = 'confidence warn';
    conf.textContent = longest
      ? 'Optimistic projection: your longest run in the last ' + p.confidenceWindowWeeks + ' weeks is ' + num(longest.distanceKm, 1) + ' km (' + longest.date + '), below ' + p.confidenceThresholdKm + ' km.'
      : 'Optimistic projection: no runs in the last ' + p.confidenceWindowWeeks + ' weeks.';
  } else {
    conf.className = 'confidence ok';
    conf.textContent = 'Longest run in the last ' + p.confidenceWindowWeeks + ' weeks: ' + num(longest.distanceKm, 1) + ' km (' + longest.date + '), at least ' + p.confidenceThresholdKm + ' km.';
  }
}

function renderFooter(d) {
  var s = d.status;
  setText('last-sync', s.source === 'sample' ? 'Last sync: sample data' : 'Last sync: ' + dateTime(s.lastSync) + (s.lastStatus && s.lastStatus !== 'ok' && s.lastStatus !== 'never_synced' ? ' · status ' + s.lastStatus : ''));
  setText('stored-runs', plural(s.storedRuns, 'run') + ' stored' + (d.totals.firstRunDate ? ' since ' + d.totals.firstRunDate : ''));
  var expiry = s.keyExpiry || {};
  setText('key-expiry', expiry.valid ? 'Garmin key expires ' + expiry.date + (expiry.expired ? ' (expired)' : ' (' + daysText(expiry.daysLeft) + ')') : 'Key expiry: set GARMIN_KEY_EXPIRES');
  setText('source', 'Source: ' + (s.source === 'sample' ? 'seed/sample-activities.json' : 'Garmin Connect'));
}

function chartFallback(id) {
  var canvas = byId(id);
  if (!canvas) return;
  canvas.replaceWith(el('div', 'chart-fallback', 'Chart.js could not be loaded.'));
}

function renderCharts(d) {
  if (typeof Chart === 'undefined') {
    chartFallback('mileage-chart');
    chartFallback('pace-chart');
    return;
  }
  var green = cssVar('--green');
  var cyan = cssVar('--cyan');
  var violet = cssVar('--violet');
  var red = cssVar('--red');
  var muted = cssVar('--muted');
  var grid = cssVar('--grid');
  Chart.defaults.color = muted;
  Chart.defaults.font.family = cssVar('--mono');
  Chart.defaults.font.size = chartFontSize();
  var tooltip = {
    backgroundColor: 'rgba(10, 14, 20, 0.96)',
    borderColor: 'rgba(77, 255, 176, 0.45)',
    borderWidth: 1,
    titleColor: '#e3e9f0',
    bodyColor: '#c9d3de',
    footerColor: muted,
    padding: 10,
    cornerRadius: 4
  };
  var labels = d.weekly.map(function (w) { return w.label; });
  var lastIndex = d.weekly.length - 1;
  var hasTrail = d.weekly.some(function (w) { return w.trailKm > 0; });

  if (charts.mileage) charts.mileage.destroy();
  charts.mileage = new Chart(byId('mileage-chart'), {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: hasTrail ? 'Road & other' : 'Distance',
          data: d.weekly.map(function (w) { return Math.round((w.distanceKm - w.trailKm) * 10) / 10; }),
          backgroundColor: d.weekly.map(function (w, i) { return i === lastIndex ? cyan + '40' : green + '33'; }),
          borderColor: d.weekly.map(function (w, i) { return i === lastIndex ? cyan : green + 'cc'; }),
          borderWidth: 1.5,
          borderRadius: 3,
          stack: 'km'
        },
        {
          label: 'Trail',
          data: d.weekly.map(function (w) { return w.trailKm; }),
          backgroundColor: violet + '40',
          borderColor: violet + 'cc',
          borderWidth: 1.5,
          borderRadius: 3,
          stack: 'km',
          hidden: !hasTrail
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: hasTrail, position: 'bottom', labels: { boxWidth: 10, boxHeight: 10 } },
        tooltip: Object.assign({}, tooltip, {
          callbacks: {
            title: function (items) { return 'Week of ' + d.weekly[items[0].dataIndex].weekStart; },
            label: function (ctx) { return ctx.dataset.label + ': ' + num(ctx.parsed.y, 1) + ' km'; },
            footer: function (items) { var w = d.weekly[items[0].dataIndex]; return 'Total ' + num(w.distanceKm, 1) + ' km · ' + plural(w.runs, 'run'); }
          }
        })
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 60 } },
        y: { stacked: true, beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { callback: function (v) { return num(v, 0) + ' km'; } } }
      }
    }
  });

  var goalPace = d.goal.paceSecPerKm;
  var paces = d.weekly.map(function (w) { return w.avgPaceSecPerKm; });
  var known = paces.filter(function (v) { return v; }).concat([goalPace]);
  var minPace = Math.min.apply(null, known);
  var maxPace = Math.max.apply(null, known);

  if (charts.pace) charts.pace.destroy();
  charts.pace = new Chart(byId('pace-chart'), {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Average pace',
          data: paces,
          borderColor: cyan,
          backgroundColor: cyan,
          pointBackgroundColor: '#080b10',
          pointBorderColor: cyan,
          pointBorderWidth: 2,
          pointRadius: 3.5,
          pointHoverRadius: 6,
          borderWidth: 2.5,
          spanGaps: true,
          tension: 0.3
        },
        {
          label: 'Goal pace ' + formatPace(goalPace) + ' /km',
          data: labels.map(function () { return goalPace; }),
          borderColor: red + 'cc',
          backgroundColor: red,
          borderDash: [7, 5],
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 0,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, boxHeight: 2 } },
        tooltip: Object.assign({}, tooltip, {
          callbacks: {
            title: function (items) { return 'Week of ' + d.weekly[items[0].dataIndex].weekStart; },
            label: function (ctx) { return (ctx.datasetIndex === 0 ? 'Average pace: ' : 'Goal pace: ') + formatPace(ctx.parsed.y) + ' /km'; }
          }
        })
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 60 } },
        y: {
          reverse: true,
          suggestedMin: minPace - 15,
          suggestedMax: maxPace + 15,
          grid: { color: grid },
          border: { display: false },
          ticks: { callback: function (v) { return formatPace(v); } }
        }
      }
    }
  });
}

function render(d) {
  current = d;
  LOCALE = d.locale;
  NUMBER_LOCALE = d.numberLocale || d.locale;
  TIMEZONE = d.timezone;
  renderHeader(d);
  renderBanners(d);
  renderCountdown(d);
  renderWeek(d);
  renderKpis(d);
  renderProjection(d);
  renderFooter(d);
  renderKeyChip(d);
  renderCharts(d);
}

function toast(message, isError) {
  var node = byId('toast');
  node.textContent = message;
  node.className = 'toast' + (isError ? ' error' : '');
}

function syncMessage(s) {
  switch (s.status) {
    case 'ok': return 'Synced: ' + s.added + ' new, ' + s.updated + ' updated.';
    case 'partial': return 'Synced ' + s.added + ' runs. More history loads on the next sync.';
    case 'sample': return 'Sample mode: Garmin was not called.';
    case 'busy': return 'A sync is already running.';
    case 'rate_limited': return 'Garmin rate limit reached. Try again later.';
    case 'key_invalid': return 'Garmin key invalid or expired.';
    case 'not_configured': return 'GARMIN_API_KEY is not set.';
    default: return 'Sync failed: ' + (s.message || s.status);
  }
}

function setButtonState(button, syncing) {
  var label = syncing ? SYNCING_LABEL : REFRESH_LABEL;
  button.disabled = syncing;
  button.classList.toggle('syncing', syncing);
  button.setAttribute('data-text', label);
  button.setAttribute('aria-label', label);
  button.querySelector('.btn-label').textContent = label;
}

function glitchOnce(button) {
  button.classList.remove('glitch-once');
  void button.offsetWidth;
  button.classList.add('glitch-once');
}

async function load() {
  try {
    var res = await fetch('/api/stats', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    render(await res.json());
  } catch (err) {
    toast('Could not load stats: ' + err.message, true);
  }
}

async function refresh() {
  var button = byId('refresh');
  setButtonState(button, true);
  toast('');
  try {
    var res = await fetch('/api/refresh', { method: 'POST' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var body = await res.json();
    render(body.stats);
    var failed = ['ok', 'partial', 'sample', 'busy'].indexOf(body.sync.status) === -1;
    toast(syncMessage(body.sync), failed);
  } catch (err) {
    toast('Refresh failed: ' + err.message, true);
  } finally {
    setButtonState(button, false);
    glitchOnce(button);
  }
}

var refreshButton = byId('refresh');
refreshButton.addEventListener('click', refresh);
refreshButton.addEventListener('animationend', function () { refreshButton.classList.remove('glitch-once'); });
var lastFontSize = chartFontSize();
var resizeTimer = null;
window.addEventListener('resize', function () {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function () {
    var size = chartFontSize();
    if (size !== lastFontSize && current) {
      lastFontSize = size;
      renderCharts(current);
    }
  }, 200);
});
load();
