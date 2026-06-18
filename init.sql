-- ============================================================
-- Seat Reservation Schema
-- ============================================================

CREATE TYPE seat_status AS ENUM ('AVAILABLE', 'LOCKED', 'BOOKED');

CREATE TABLE IF NOT EXISTS seats (
    id          VARCHAR(10)  PRIMARY KEY,
    status      seat_status  NOT NULL DEFAULT 'AVAILABLE',
    locked_by   VARCHAR(255) NULL,
    locked_at   TIMESTAMPTZ  NULL
);

-- ============================================================
-- Seed 100 seats: A1–J10
-- Rows A–J (10 rows) x Seats 1–10 = 100 seats
-- ============================================================

INSERT INTO seats (id)
SELECT
    chr(64 + row_num) || seat_num::TEXT
FROM
    generate_series(1, 10) AS row_num,
    generate_series(1, 10) AS seat_num
ON CONFLICT (id) DO NOTHING;