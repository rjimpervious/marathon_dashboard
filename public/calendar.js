const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

let locale = 'en-GB';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function num(value, digits) {
  return Number(value).toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function dayCell(day) {
  const linked = day.runIds && day.runIds.length > 0;
  const classes = ['cal-day'];
  if (linked) classes.push('has-run');
  if (day.isToday) classes.push('today');
  if (day.isFuture) classes.push('future');
  const cell = el(linked ? 'a' : 'div', classes.join(' '));
  if (linked) {
    cell.href = '/run?ids=' + day.runIds.join(',');
    cell.setAttribute('aria-label', day.weekday + ' ' + day.date + ': ' + num(day.distanceKm, 1) + ' km' + (day.averageHR ? ', heart rate ' + day.averageHR : '') + ', open details');
    if (day.names && day.names.length) cell.title = day.names.join(' · ');
  }
  cell.appendChild(el('div', 'cal-date', day.label));
  if (linked) {
    const km = el('div', 'cal-km', num(day.distanceKm, 1));
    km.appendChild(el('small', null, 'km'));
    cell.appendChild(km);
    if (day.averageHR) cell.appendChild(el('div', 'cal-hr hr', day.averageHR + ' bpm'));
    if (day.runs > 1) cell.appendChild(el('div', 'cal-count', day.runs + ' runs'));
  }
  return cell;
}

function render(data) {
  locale = data.numberLocale || data.locale || locale;
  const grid = document.getElementById('calendar');
  grid.textContent = '';
  WEEKDAYS.forEach((name) => grid.appendChild(el('div', 'cal-head', name)));
  grid.appendChild(el('div', 'cal-head cal-total-head', 'Week'));
  data.calendar.forEach((week) => {
    week.days.forEach((day) => grid.appendChild(dayCell(day)));
    const total = el('div', 'cal-total');
    const km = el('div', 'cal-km', num(week.distanceKm, 1));
    km.appendChild(el('small', null, 'km'));
    total.appendChild(km);
    total.appendChild(el('div', 'cal-count', week.runs + (week.runs === 1 ? ' run' : ' runs')));
    grid.appendChild(total);
  });
  const first = data.calendar[0];
  const last = data.calendar[data.calendar.length - 1];
  const km = data.calendar.reduce((sum, week) => sum + week.distanceKm, 0);
  const runs = data.calendar.reduce((sum, week) => sum + week.runs, 0);
  document.getElementById('sysline').textContent = first.from + ' to ' + last.to + ' · ' + num(km, 1) + ' km · ' + runs + (runs === 1 ? ' run' : ' runs');
}

async function load() {
  try {
    const res = await fetch('/api/stats', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    render(await res.json());
  } catch (err) {
    document.getElementById('sysline').textContent = 'Could not load the calendar: ' + err.message;
  }
}

load();
