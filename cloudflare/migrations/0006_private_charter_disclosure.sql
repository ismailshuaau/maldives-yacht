ALTER TABLE yachts ADD COLUMN private_rate_public INTEGER NOT NULL DEFAULT 0;
ALTER TABLE yachts ADD COLUMN private_instant_booking INTEGER NOT NULL DEFAULT 0;
ALTER TABLE yachts ADD COLUMN private_min_nights INTEGER;
ALTER TABLE yachts ADD COLUMN private_max_nights INTEGER;

ALTER TABLE enquiries ADD COLUMN start_date TEXT;
ALTER TABLE enquiries ADD COLUMN end_date TEXT;

CREATE INDEX IF NOT EXISTS idx_yachts_private_public_rate
ON yachts(status, verified, private_enabled, private_rate_public, private_rate);
