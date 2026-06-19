import { createClient, RedisClientType } from 'redis';

/**
 * Redis requires two separate connections for pub/sub: a client that is
 * actively subscribed cannot also issue normal commands (including
 * PUBLISH) on the same connection. We export two distinct clients so
 * the rest of the app never has to think about this constraint.
 */
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

function createRedisClient(label: string): RedisClientType {
  const client: RedisClientType = createClient({ url: REDIS_URL });

  client.on('error', (err) => {
    console.error(`[redis:${label}] connection error:`, err);
  });

  client.on('connect', () => {
    console.log(`[redis:${label}] connected`);
  });

  return client;
}

export const redisPublisher = createRedisClient('publisher');
export const redisSubscriber = createRedisClient('subscriber');

/**
 * Connects both clients. Call this once at server startup.
 */
export async function connectRedis(): Promise<void> {
  await Promise.all([redisPublisher.connect(), redisSubscriber.connect()]);
}