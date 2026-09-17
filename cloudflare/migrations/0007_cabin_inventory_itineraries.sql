ALTER TABLE departures ADD COLUMN embarkation TEXT;
ALTER TABLE departures ADD COLUMN disembarkation TEXT;
ALTER TABLE departures ADD COLUMN itinerary_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS yacht_cabin_types(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 yacht_id INTEGER NOT NULL,
 name TEXT NOT NULL,
 deck TEXT,
 bed_configuration TEXT,
 description TEXT,
 image TEXT,
 capacity INTEGER NOT NULL DEFAULT 2 CHECK(capacity > 0),
 sort_order INTEGER NOT NULL DEFAULT 0,
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT,
 updated_at TEXT,
 FOREIGN KEY(yacht_id) REFERENCES yachts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS departure_cabin_inventory(
 departure_id INTEGER NOT NULL,
 cabin_type_id INTEGER NOT NULL,
 cabins_total INTEGER NOT NULL CHECK(cabins_total >= 0),
 cabins_available INTEGER NOT NULL CHECK(cabins_available >= 0 AND cabins_available <= cabins_total),
 price_pp REAL NOT NULL CHECK(price_pp >= 0),
 PRIMARY KEY(departure_id,cabin_type_id),
 FOREIGN KEY(departure_id) REFERENCES departures(id) ON DELETE CASCADE,
 FOREIGN KEY(cabin_type_id) REFERENCES yacht_cabin_types(id) ON DELETE CASCADE
);
CREATE TRIGGER IF NOT EXISTS validate_departure_cabin_owner_insert
BEFORE INSERT ON departure_cabin_inventory
WHEN (SELECT yacht_id FROM departures WHERE id=NEW.departure_id) != (SELECT yacht_id FROM yacht_cabin_types WHERE id=NEW.cabin_type_id)
BEGIN SELECT RAISE(ABORT,'cabin category does not belong to departure yacht'); END;
CREATE TRIGGER IF NOT EXISTS validate_departure_cabin_owner_update
BEFORE UPDATE ON departure_cabin_inventory
WHEN (SELECT yacht_id FROM departures WHERE id=NEW.departure_id) != (SELECT yacht_id FROM yacht_cabin_types WHERE id=NEW.cabin_type_id)
BEGIN SELECT RAISE(ABORT,'cabin category does not belong to departure yacht'); END;

CREATE TABLE IF NOT EXISTS booking_cabin_items(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 booking_id INTEGER NOT NULL,
 cabin_type_id INTEGER,
 cabin_type_name TEXT NOT NULL,
 cabins INTEGER NOT NULL CHECK(cabins > 0),
 guests INTEGER NOT NULL CHECK(guests > 0),
 capacity INTEGER NOT NULL CHECK(capacity > 0),
 price_pp REAL NOT NULL CHECK(price_pp >= 0),
 line_total REAL NOT NULL CHECK(line_total >= 0),
 FOREIGN KEY(booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
 FOREIGN KEY(cabin_type_id) REFERENCES yacht_cabin_types(id)
);

CREATE TABLE IF NOT EXISTS availability_hold_cabin_items(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 hold_id INTEGER NOT NULL,
 departure_id INTEGER NOT NULL,
 cabin_type_id INTEGER NOT NULL,
 cabins INTEGER NOT NULL CHECK(cabins > 0),
 FOREIGN KEY(hold_id) REFERENCES availability_holds(id) ON DELETE CASCADE,
 FOREIGN KEY(departure_id,cabin_type_id) REFERENCES departure_cabin_inventory(departure_id,cabin_type_id)
);

CREATE TRIGGER IF NOT EXISTS prevent_cabin_category_overbooking
BEFORE INSERT ON availability_hold_cabin_items
BEGIN
 SELECT (CASE WHEN NEW.cabins + COALESCE((
   SELECT SUM(i.cabins) FROM availability_hold_cabin_items i
   JOIN availability_holds h ON h.id=i.hold_id
   WHERE i.departure_id=NEW.departure_id AND i.cabin_type_id=NEW.cabin_type_id
     AND h.status='active' AND h.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 ),0) > COALESCE((
   SELECT cabins_available FROM departure_cabin_inventory
   WHERE departure_id=NEW.departure_id AND cabin_type_id=NEW.cabin_type_id
 ),0) THEN RAISE(ABORT,'cabin category inventory unavailable') END);
END;

CREATE INDEX IF NOT EXISTS idx_cabin_types_yacht ON yacht_cabin_types(yacht_id,active,sort_order);
CREATE INDEX IF NOT EXISTS idx_hold_cabin_inventory ON availability_hold_cabin_items(departure_id,cabin_type_id);

INSERT INTO yacht_cabin_types(yacht_id,name,deck,bed_configuration,description,image,capacity,sort_order,active,created_at,updated_at)
SELECT y.id,'Standard Cabin',NULL,'Twin or double','Comfortable onboard accommodation.',y.image,
       MAX(1,CAST((y.guests + MAX(y.cabins,1) - 1) / MAX(y.cabins,1) AS INTEGER)),0,1,datetime('now'),datetime('now')
FROM yachts y
WHERE NOT EXISTS(SELECT 1 FROM yacht_cabin_types c WHERE c.yacht_id=y.id);

INSERT INTO departure_cabin_inventory(departure_id,cabin_type_id,cabins_total,cabins_available,price_pp)
SELECT d.id,c.id,COALESCE(d.cabins_total,0),COALESCE(d.cabins_available,0),COALESCE(d.price_pp,0)
FROM departures d JOIN yacht_cabin_types c ON c.yacht_id=d.yacht_id
WHERE c.name='Standard Cabin'
  AND NOT EXISTS(SELECT 1 FROM departure_cabin_inventory i WHERE i.departure_id=d.id);
