CREATE INDEX IF NOT EXISTS idx_yachts_public_rating
ON yachts(status, verified, rating DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_yachts_private_search
ON yachts(status, verified, private_enabled, type, rating DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_yachts_shared_search
ON yachts(status, verified, shared_enabled, rating DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_departures_open_dates
ON departures(status, start_date, end_date, nights, yacht_id);

CREATE INDEX IF NOT EXISTS idx_holds_departure_active
ON availability_holds(departure_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_holds_private_active_dates
ON availability_holds(yacht_id, start_date, end_date, expires_at)
WHERE status='active' AND departure_id IS NULL;

PRAGMA optimize;
