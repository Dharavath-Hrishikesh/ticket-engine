import pool from './db';

const LOCK_TIMEOUT_INTERVAL = '5 minutes';
const REAPER_INTERVAL_MS = 60000; // 1 minute

/**
 * Starts a background interval that periodically releases stale seat
 * locks. If a seat has been LOCKED for longer than the timeout window
 * (e.g. a client locked it but never completed booking, or crashed),
 * it is reset back to AVAILABLE so other users aren't blocked forever.
 */
export function startLockReaper(): void {
  setInterval(async () => {
    try {
      const result = await pool.query(
        `UPDATE seats
         SET status = 'AVAILABLE', locked_by = NULL, locked_at = NULL
         WHERE status = 'LOCKED'
           AND locked_at < NOW() - INTERVAL '${LOCK_TIMEOUT_INTERVAL}'`
      );

      if (result.rowCount && result.rowCount > 0) {
        console.log(`[lock-reaper] Released ${result.rowCount} stale seat lock(s)`);
      }
    } catch (err) {
      console.error('[lock-reaper] Failed to release stale locks:', err);
    }
  }, REAPER_INTERVAL_MS);

  console.log('[lock-reaper] Started (checking every 60s for locks older than 5 minutes)');
}