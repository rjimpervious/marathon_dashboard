export function formatDuration(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined || !isFinite(totalSeconds)) return '–';
  const s = Math.round(Math.abs(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (totalSeconds < 0 ? '-' : '') + h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

export function formatPace(secondsPerKm) {
  if (!secondsPerKm || !isFinite(secondsPerKm)) return '–';
  const s = Math.round(secondsPerKm);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
