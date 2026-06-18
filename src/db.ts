import { Pool } from 'pg';

/**
 * Postgres connection pool.
 *
 * Defaults match the local docker-compose setup (user=postgres,
 * password=postgres, database=seats, port=5432, host=localhost).
 * Override via environment variables for staging/production.
 */
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'seats',
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client', err);
});

export default pool;