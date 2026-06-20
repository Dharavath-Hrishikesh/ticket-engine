import express, { Request, Response } from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import pool from './db';
import { startLockReaper } from './worker';
import { connectRedis, redisPublisher, redisSubscriber } from './redis';

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

const SEAT_UPDATES_CHANNEL = 'seat_updates';

interface SeatUpdateMessage {
  seat_id: string;
  status: 'LOCKED' | 'BOOKED';
  user_id: string;
}

/**
 * Publishes a seat status change to Redis. All server instances
 * subscribed to SEAT_UPDATES_CHANNEL (including this one) will
 * receive it and relay it to their connected WebSocket clients.
 */
async function publishSeatUpdate(message: SeatUpdateMessage): Promise<void> {
  try {
    await redisPublisher.publish(SEAT_UPDATES_CHANNEL, JSON.stringify(message));
  } catch (err) {
    console.error('[redis] Failed to publish seat update:', err);
  }
}

app.use(express.json());

/**
 * We create a raw http.Server explicitly and pass the Express app as
 * its request handler, rather than relying on the server app.listen()
 * creates implicitly. This is required so the ws WebSocketServer can
 * attach to the same underlying server and share one port for both
 * HTTP and WebSocket traffic.
 */
const server = http.createServer(app);

const wss = new WebSocketServer({ server });

wss.on('connection', (ws: WebSocket) => {
  console.log('[ws] New WebSocket client connected');

  ws.on('close', () => {
    console.log('[ws] WebSocket client disconnected');
  });

  ws.on('error', (err) => {
    console.error('[ws] WebSocket client error:', err);
  });
});

app.get('/health', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.status(200).json({
      status: 'ok',
      db_time: result.rows[0].now,
    });
  } catch (err) {
    console.error('Database connection failed:', err);
    res.status(500).json({ status: 'error', message: 'Database connection failed' });
  }
});

/**
 * GET /api/seats
 *
 * Returns all seats, ordered by id (e.g. A1, A10, A2, ... — see note
 * below on lexicographic vs natural ordering).
 */
app.get('/api/seats', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query('SELECT * FROM seats ORDER BY id');
    return res.status(200).json({
      status: 'ok',
      seats: result.rows,
    });
  } catch (err) {
    console.error('Failed to fetch seats:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

/**
 * POST /api/seats/:id/lock
 *
 * Attempts to lock a seat for a given user. Uses a row-level lock
 * (SELECT ... FOR UPDATE) inside a transaction to ensure that under
 * concurrent requests for the same seat, only one request can
 * successfully transition it from AVAILABLE -> LOCKED.
 */
app.post('/api/seats/:id/lock', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { locked_by } = req.body;

  if (!locked_by) {
    return res.status(400).json({ status: 'error', message: 'locked_by is required' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const seatResult = await client.query(
      'SELECT * FROM seats WHERE id = $1 FOR UPDATE',
      [id]
    );

    if (seatResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'error', message: 'Seat not found' });
    }

    const seat = seatResult.rows[0];

    if (seat.status !== 'AVAILABLE') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        status: 'error',
        message: `Seat is already ${seat.status}`,
      });
    }

    await client.query(
      `UPDATE seats
       SET status = 'LOCKED', locked_by = $2, locked_at = NOW()
       WHERE id = $1`,
      [id, locked_by]
    );

    await client.query('COMMIT');

    await publishSeatUpdate({ seat_id: seat.id, status: 'LOCKED', user_id: locked_by });

    return res.status(200).json({
      status: 'ok',
      message: `Seat ${id} locked by ${locked_by}`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to lock seat:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/seats/:id/book
 *
 * Finalizes a reservation. Only succeeds if the seat is currently
 * LOCKED by the same user_id requesting the booking — this prevents
 * one user from booking a seat that another user holds a lock on.
 */
app.post('/api/seats/:id/book', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ status: 'error', message: 'user_id is required' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const seatResult = await client.query(
      'SELECT * FROM seats WHERE id = $1 FOR UPDATE',
      [id]
    );

    if (seatResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'error', message: 'Seat not found' });
    }

    const seat = seatResult.rows[0];

    if (seat.status !== 'LOCKED' || seat.locked_by !== user_id) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        status: 'error',
        message: 'Seat is not locked by this user',
      });
    }

    await client.query(
      `UPDATE seats
       SET status = 'BOOKED', locked_by = $2
       WHERE id = $1`,
      [id, user_id]
    );

    await client.query('COMMIT');

    await publishSeatUpdate({ seat_id: seat.id, status: 'BOOKED', user_id });

    return res.status(200).json({
      status: 'ok',
      message: `Seat ${id} booked by ${user_id}`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to book seat:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  } finally {
    client.release();
  }
});

async function startServer(): Promise<void> {
  try {
    await connectRedis();

    await redisSubscriber.subscribe(SEAT_UPDATES_CHANNEL, (message: string) => {
      let parsed: SeatUpdateMessage;

      try {
        parsed = JSON.parse(message);
      } catch (err) {
        console.error('[redis] Failed to parse seat update message:', err);
        return;
      }

      const payload = JSON.stringify(parsed);

      wss.clients.forEach((ws: WebSocket) => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(payload);
          } catch (err) {
            console.error('[ws] Failed to send message to client:', err);
          }
        }
      });
    });
  } catch (err) {
    console.error('Failed to connect to Redis:', err);
    process.exit(1);
  }

  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    startLockReaper();
  });
}

startServer();