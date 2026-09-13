ALTER TABLE departures ADD COLUMN places_total INTEGER;
ALTER TABLE departures ADD COLUMN places_available INTEGER;
ALTER TABLE bookings ADD COLUMN cabins_booked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE availability_holds ADD COLUMN cabin_units INTEGER NOT NULL DEFAULT 0;

UPDATE departures
SET places_total=COALESCE((SELECT guests FROM yachts WHERE yachts.id=departures.yacht_id),0),
    places_available=MIN(
      COALESCE((SELECT guests FROM yachts WHERE yachts.id=departures.yacht_id),0),
      COALESCE(cabins_available,0)*2
    );
