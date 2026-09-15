ALTER TABLE bookings ADD COLUMN access_token_hash TEXT;
ALTER TABLE bookings ADD COLUMN idempotency_key TEXT;
ALTER TABLE payments ADD COLUMN access_token_hash TEXT;
ALTER TABLE payments ADD COLUMN idempotency_key TEXT;
ALTER TABLE payouts ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_idempotency ON bookings(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_idempotency ON payments(idempotency_key) WHERE idempotency_key IS NOT NULL;
UPDATE payments SET status='failed',updated_at=CURRENT_TIMESTAMP
WHERE status IN ('created','pending') AND id NOT IN (SELECT MAX(id) FROM payments WHERE status IN ('created','pending') GROUP BY booking_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_active_intent ON payments(booking_id) WHERE status IN ('created','pending');
CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_idempotency ON payouts(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_holds_booking ON availability_holds(booking_id);

CREATE TABLE IF NOT EXISTS login_rate_limits(
 key_hash TEXT PRIMARY KEY,
 window_started INTEGER NOT NULL,
 attempts INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_hold_private_inventory
BEFORE INSERT ON availability_holds
WHEN NEW.status='active' AND NEW.departure_id IS NULL AND EXISTS(
 SELECT 1 FROM availability_holds h
 WHERE h.yacht_id=NEW.yacht_id AND h.departure_id IS NULL AND h.status='active'
   AND datetime(h.expires_at)>datetime('now')
   AND date(h.start_date)<date(NEW.end_date) AND date(h.end_date)>date(NEW.start_date)
)
BEGIN
 SELECT RAISE(ABORT,'private inventory unavailable');
END;

CREATE TRIGGER IF NOT EXISTS trg_hold_shared_inventory
BEFORE INSERT ON availability_holds
WHEN NEW.status='active' AND NEW.departure_id IS NOT NULL AND EXISTS(
 SELECT 1 FROM departures d
 WHERE d.id=NEW.departure_id AND (
   NEW.units + COALESCE((SELECT SUM(h.units) FROM availability_holds h WHERE h.departure_id=d.id AND h.status='active' AND datetime(h.expires_at)>datetime('now')),0) > d.places_available
   OR NEW.cabin_units + COALESCE((SELECT SUM(h.cabin_units) FROM availability_holds h WHERE h.departure_id=d.id AND h.status='active' AND datetime(h.expires_at)>datetime('now')),0) > d.cabins_available
 )
)
BEGIN
 SELECT RAISE(ABORT,'shared inventory unavailable');
END;

CREATE TRIGGER IF NOT EXISTS trg_refund_total
BEFORE INSERT ON refunds
WHEN NEW.amount<=0 OR NEW.amount + COALESCE((SELECT SUM(amount) FROM refunds WHERE payment_id=NEW.payment_id AND status IN ('recorded','processed')),0) > COALESCE((SELECT amount FROM payments WHERE id=NEW.payment_id),0)
BEGIN
 SELECT RAISE(ABORT,'invalid refund total');
END;

CREATE TRIGGER IF NOT EXISTS trg_payout_balance
BEFORE INSERT ON payouts
WHEN NEW.amount<=0 OR NEW.amount > (
 COALESCE((SELECT SUM(p.operator_net_amount) FROM payments p JOIN bookings b ON b.id=p.booking_id JOIN yachts y ON y.id=b.yacht_id WHERE y.vendor_id=NEW.vendor_id AND p.status='paid'),0)
 - COALESCE((SELECT SUM(r.operator_reversal) FROM refunds r JOIN payments p ON p.id=r.payment_id JOIN bookings b ON b.id=p.booking_id JOIN yachts y ON y.id=b.yacht_id WHERE y.vendor_id=NEW.vendor_id AND r.status IN ('recorded','processed')),0)
 - COALESCE((SELECT SUM(amount) FROM payouts WHERE vendor_id=NEW.vendor_id AND status IN ('pending','paid')),0)
)
BEGIN
 SELECT RAISE(ABORT,'payout exceeds available balance');
END;
