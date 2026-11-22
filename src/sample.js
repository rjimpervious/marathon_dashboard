import sampleActivities from '../seed/sample-activities.json';
import { DAY_MS, dayMsFromKey, localDateKey, shiftDateKey } from './stats.js';

function shiftedRuns(now, timezone, shiftToToday) {
  if (!shiftToToday || !sampleActivities.length) return sampleActivities;
  const today = dayMsFromKey(localDateKey(now, timezone));
  const newest = Math.max(...sampleActivities.map((a) => dayMsFromKey(a.startLocal)));
  const offsetDays = Math.floor((today - newest) / DAY_MS / 7) * 7;
  if (!offsetDays) return sampleActivities;
  return sampleActivities.map((a) => ({
    ...a,
    startLocal: shiftDateKey(a.startLocal, offsetDays) + a.startLocal.slice(10),
  }));
}

export function sampleSource({ now, timezone, shiftToToday }) {
  const runs = shiftedRuns(now, timezone, shiftToToday);
  const meta = { lastStatus: 'sample', backfill: { done: true }, storedRuns: runs.length };
  return {
    name: 'sample',
    async runs() {
      return runs;
    },
    async meta() {
      return meta;
    },
    async tokenExpiresAt() {
      return null;
    },
    async sync(trigger) {
      console.log('[sync] ' + trigger + ': sample mode, Garmin not called');
      return { result: { status: 'sample', trigger, at: now.toISOString(), added: 0, updated: 0 }, runs, meta };
    },
  };
}
