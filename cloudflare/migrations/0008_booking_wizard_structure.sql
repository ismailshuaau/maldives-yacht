ALTER TABLE yacht_cabin_types ADD COLUMN gallery_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE yacht_cabin_types ADD COLUMN window_type TEXT;
ALTER TABLE yacht_cabin_types ADD COLUMN air_conditioning INTEGER NOT NULL DEFAULT 0;
ALTER TABLE yacht_cabin_types ADD COLUMN ensuite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE yacht_cabin_types ADD COLUMN occupancy_modes_json TEXT NOT NULL DEFAULT '["private"]';

ALTER TABLE departure_cabin_inventory ADD COLUMN list_price_pp REAL;
ALTER TABLE departure_cabin_inventory ADD COLUMN promotion_label TEXT;
ALTER TABLE departure_cabin_inventory ADD COLUMN promotion_starts_at TEXT;
ALTER TABLE departure_cabin_inventory ADD COLUMN promotion_ends_at TEXT;
ALTER TABLE departure_cabin_inventory ADD COLUMN low_stock_threshold INTEGER NOT NULL DEFAULT 4;
ALTER TABLE departure_cabin_inventory ADD COLUMN single_occupancy_surcharge_percent REAL NOT NULL DEFAULT 0;
ALTER TABLE departure_cabin_inventory ADD COLUMN privacy_surcharge_percent REAL NOT NULL DEFAULT 0;

ALTER TABLE booking_cabin_items ADD COLUMN occupancy_preference TEXT NOT NULL DEFAULT 'private';
ALTER TABLE booking_cabin_items ADD COLUMN list_price_pp REAL;
ALTER TABLE booking_cabin_items ADD COLUMN discount_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE booking_cabin_items ADD COLUMN surcharge_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE booking_cabin_items ADD COLUMN inventory_units INTEGER NOT NULL DEFAULT 0;

ALTER TABLE availability_hold_cabin_items ADD COLUMN inventory_units INTEGER NOT NULL DEFAULT 0;

DROP TRIGGER IF EXISTS prevent_cabin_category_overbooking;
CREATE TRIGGER prevent_cabin_category_overbooking
BEFORE INSERT ON availability_hold_cabin_items
BEGIN
 SELECT (CASE WHEN NEW.inventory_units + COALESCE((
   SELECT SUM(CASE WHEN i.inventory_units>0 THEN i.inventory_units ELSE i.cabins*c.capacity END)
   FROM availability_hold_cabin_items i JOIN availability_holds h ON h.id=i.hold_id
   JOIN yacht_cabin_types c ON c.id=i.cabin_type_id
   WHERE i.departure_id=NEW.departure_id AND i.cabin_type_id=NEW.cabin_type_id
     AND h.status='active' AND h.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 ),0) > COALESCE((
   SELECT d.cabins_available*c.capacity FROM departure_cabin_inventory d
   JOIN yacht_cabin_types c ON c.id=d.cabin_type_id
   WHERE d.departure_id=NEW.departure_id AND d.cabin_type_id=NEW.cabin_type_id
 ),0) THEN RAISE(ABORT,'cabin category inventory unavailable') END);
END;

ALTER TABLE bookings ADD COLUMN conditions_version TEXT;
ALTER TABLE bookings ADD COLUMN conditions_snapshot_json TEXT;
ALTER TABLE bookings ADD COLUMN conditions_accepted_at TEXT;

ALTER TABLE departures ADD COLUMN booking_conditions_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS booking_guests(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 booking_id INTEGER NOT NULL,
 full_name TEXT,
 rooming_preference TEXT,
 notes TEXT,
 sort_order INTEGER NOT NULL DEFAULT 0,
 FOREIGN KEY(booking_id) REFERENCES bookings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_booking_guests_booking ON booking_guests(booking_id,sort_order,id);

UPDATE yacht_cabin_types
SET gallery_json=CASE WHEN image IS NULL OR image='' THEN '[]' ELSE json_array(image) END,
    occupancy_modes_json='["shared","private"]'
WHERE gallery_json='[]';

UPDATE departure_cabin_inventory
SET list_price_pp=price_pp
WHERE list_price_pp IS NULL;

INSERT OR IGNORE INTO platform_settings(key,value,updated_at) VALUES
 ('booking_conditions_version','2026-09-17',datetime('now')),
 ('booking_conditions_intro','Reservations create a temporary availability hold. No payment is taken until you choose to continue to payment.',datetime('now')),
 ('best_price_guarantee_enabled','0',datetime('now')),
 ('best_price_guarantee_text','',datetime('now'));
