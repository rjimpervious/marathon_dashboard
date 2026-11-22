import { formatDuration, formatPace } from './format.js';

const TYPE_NAMES = {
  running: 'Run',
  trail_running: 'Trail run',
  treadmill_running: 'Treadmill',
  track_running: 'Track',
  street_running: 'Street run',
  indoor_running: 'Indoor run',
  virtual_run: 'Virtual run',
  ultra_run: 'Ultra',
};

let numberLocale = 'en-GB';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function num(value, digits) {
  return Number(value).toLocaleString(numberLocale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function metric(kind, label, value, unit, note) {
  const box = el('div', 'metric ' + kind);
  box.appendChild(el('div', 'm-label', label));
  const v = el('div', 'm-value', value);
  if (unit) v.appendChild(el('small', null, unit));
  box.appendChild(v);
  if (note) box.appendChild(el('div', 'm-note', note));
  return box;
}

function heartMetric(run, maxHeartRate, restingHeartRate) {
  const box = metric('heart hero', 'Average heart rate', String(run.averageHR), 'bpm');
  const bits = [];
  if (run.maxHR !== undefined) bits.push('Max ' + run.maxHR + ' bpm');
  if (run.percentMaxHr !== undefined) bits.push(run.percentMaxHr + '% of max');
  if (run.percentReserve !== undefined) bits.push(run.percentReserve + '% of reserve');
  if (bits.length) box.appendChild(el('div', 'm-note', bits.join(' · ')));
  if (run.percentReserve !== undefined) {
    const track = el('div', 'reserve');
    const fill = el('span');
    fill.style.width = Math.min(100, run.percentReserve) + '%';
    track.appendChild(fill);
    box.appendChild(track);
    const ends = el('div', 'reserve-ends');
    ends.appendChild(el('span', null, 'Resting ' + restingHeartRate));
    ends.appendChild(el('span', null, 'Max ' + maxHeartRate));
    box.appendChild(ends);
  }
  return box;
}

function metricsFor(run, maxHeartRate, restingHeartRate) {
  const hasHeartRate = run.averageHR !== undefined;
  const items = [];
  items.push(metric('pace hero' + (hasHeartRate ? '' : ' wide'), 'Pace', formatPace(run.paceSecPerKm), '/km', run.paceSecPerKm ? num(3600 / run.paceSecPerKm, 1) + ' km/h' : ''));
  if (hasHeartRate) items.push(heartMetric(run, maxHeartRate, restingHeartRate));
  items.push(metric('small', 'Distance', num(run.distanceKm, 2), 'km'));
  const moving = run.movingSeconds && run.movingSeconds < run.durationSeconds - 5 ? 'Moving ' + formatDuration(run.movingSeconds) : '';
  items.push(metric('small', 'Time', formatDuration(run.durationSeconds), '', moving));
  if (run.elevationGain !== undefined) {
    items.push(metric('mini', 'Elevation gain', num(run.elevationGain, 0), 'm', run.elevationLoss !== undefined ? 'Loss ' + num(run.elevationLoss, 0) + ' m' : ''));
  }
  if (run.cadence !== undefined) {
    items.push(metric('mini', 'Cadence', String(run.cadence), 'spm', run.strideLengthCm !== undefined ? 'Stride ' + num(run.strideLengthCm / 100, 2) + ' m' : ''));
  }
  if (run.calories !== undefined) items.push(metric('mini', 'Calories', num(run.calories, 0), 'kcal'));
  return items;
}

function noteFor(run, maxHeartRate, restingHeartRate) {
  const parts = [];
  if (run.vo2maxFromHeartRate !== undefined) {
    parts.push('Fitness estimate from this run: VO2max ' + num(run.vo2maxFromHeartRate, 1) + ', from its pace and average heart rate (max ' + maxHeartRate + ', resting ' + restingHeartRate + ' bpm).');
  }
  if (run.vo2maxGarmin !== undefined) parts.push('Garmin\'s own VO2max for this run: ' + num(run.vo2maxGarmin, 1) + '.');
  return parts.join(' ');
}

function card(run, maxHeartRate, restingHeartRate) {
  const section = el('section', 'card run-card');
  section.appendChild(el('div', 'label', TYPE_NAMES[run.type] || run.type));
  section.appendChild(el('h2', null, run.name || 'Untitled run'));
  const place = run.locationName ? ' · ' + run.locationName : '';
  section.appendChild(el('div', 'run-sub', run.weekday + ' ' + run.date + ' · ' + run.time + place));
  const grid = el('div', 'run-grid');
  metricsFor(run, maxHeartRate, restingHeartRate).forEach((item) => grid.appendChild(item));
  section.appendChild(grid);
  const note = noteFor(run, maxHeartRate, restingHeartRate);
  if (note) section.appendChild(el('div', 'run-note', note));
  return section;
}

function show(message) {
  document.getElementById('sysline').textContent = message;
}

async function load() {
  const ids = (new URLSearchParams(location.search).get('ids') || '').split(',').filter(Boolean);
  if (!ids.length) {
    show('No run selected');
    return;
  }
  try {
    const res = await fetch('/api/runs?ids=' + encodeURIComponent(ids.join(',')), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    numberLocale = body.numberLocale || body.locale || numberLocale;
    const box = document.getElementById('runs');
    box.textContent = '';
    if (!body.runs.length) {
      show('Run not found');
      return;
    }
    body.runs.forEach((run) => box.appendChild(card(run, body.maxHeartRate, body.restingHeartRate)));
    show(body.runs.length === 1 ? body.runs[0].weekday + ' ' + body.runs[0].date : body.runs.length + ' runs on ' + body.runs[0].date);
    document.title = body.runs[0].name + ' · Run details';
  } catch (err) {
    show('Could not load the run: ' + err.message);
  }
}

load();
