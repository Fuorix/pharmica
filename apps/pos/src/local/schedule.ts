/** Longest wait between sync attempts while the server is unreachable. */
export const MAX_SYNC_DELAY_MS = 5 * 60 * 1000;

/**
 * How long to wait before the next sync. Normally `baseMs`; after failures it doubles each time up to five
 * minutes, and is spread by +/-20% so many counters coming back online do not all call the server at once.
 */
export function nextSyncDelay(consecutiveFailures: number, baseMs: number, random: number): number {
  if (consecutiveFailures <= 0) return baseMs;
  const backedOff = Math.min(MAX_SYNC_DELAY_MS, baseMs * 2 ** consecutiveFailures);
  return Math.round(backedOff * (0.8 + 0.4 * random));
}
