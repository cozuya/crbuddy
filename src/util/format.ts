/** Human-facing formatting. Terminal output, never file content. */

/**
 * Bytes are how git measures a diff; they are not how anyone estimates
 * whether a review will be slow. Show a unit people reason in.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;

  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;

  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/** Local wall-clock time, e.g. "3:15pm" — or "15:15" in a 24h locale. */
export function formatClock(date = new Date()): string {
  return date
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    .replace(/\s*([AP])\.?M\.?/i, (_match, meridiem: string) =>
      meridiem.toLowerCase() === 'a' ? 'am' : 'pm',
    );
}

/** Elapsed time for a run in progress: "42s", "3m 05s", "1h 12m". */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);

  if (total < 60) return `${total}s`;

  const minutes = Math.floor(total / 60);
  const seconds = total % 60;

  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}
