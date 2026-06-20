import pool from './db';
import { redisPublisher } from './redis';

const LOCK_TIMEOUT_INTERVAL = '5 minutes';
const REAPER_INTERVAL_MS = 60000; // 1 minute
const SEAT_UPDATES_CHANNEL = 'seat_updates';

interface SeatUpdateMessage {
  id: string;
  status: 'AVAILABLE';
  user_id: null;
}

/**
 * Publishes a single seat-released update to Redis. Failures are
 * logged but never thrown — a broken Redis publish should not stop
 * the reaper from continuing to free other stale locks.
 */
async function publishSeatReleased(seatId: string): Promise<void> {
  const message: SeatUpdateMessage = {
    id: seatId,
    status: 'AVAILABLE',
    user_id: null,
  };

  try {
    await redisPublisher.publish(SEAT_UPDATES_CHANNEL, JSON.stringify(message));
  } catch (err) {
    console.error(`[lock-reaper] Failed to publish release for seat ${seatId}:`, err);
  }
}

/**
 * Starts a background interval that periodically releases stale seat
 * locks. If a seat has been LOCKED for longer than the timeout window
 * (e.g. a client locked it but never completed booking, or crashed),
 * it is reset back to AVAILABLE so other users aren't blocked forever.
 */
export function startLockReaper(): void {
  setInterval(async () => {
    try {
      const result = await pool.query<{ id: string }>(
        `UPDATE seats
         SET status = 'AVAILABLE', locked_by = NULL, locked_at = NULL
         WHERE status = 'LOCKED'
           AND locked_at < NOW() - INTERVAL '${LOCK_TIMEOUT_INTERVAL}'
         RETURNING id`
      );

      if (result.rowCount && result.rowCount > 0) {
        console.log(`[lock-reaper] Released ${result.rowCount} stale seat lock(s)`);

        await Promise.all(result.rows.map((row) => publishSeatReleased(row.id)));
      }
    } catch (err) {
      console.error('[lock-reaper] Failed to release stale locks:', err);
    }
  }, REAPER_INTERVAL_MS);

  console.log('[lock-reaper] Started (checking every 60s for locks older than 5 minutes)');
}