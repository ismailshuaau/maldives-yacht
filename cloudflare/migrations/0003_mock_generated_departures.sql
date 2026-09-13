ALTER TABLE departures ADD COLUMN mock_generated INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_departures_yacht_schedule
ON departures(yacht_id, status, mock_generated, start_date);
