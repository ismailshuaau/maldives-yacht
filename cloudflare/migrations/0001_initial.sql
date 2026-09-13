CREATE TABLE IF NOT EXISTS vendors(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 email TEXT UNIQUE,
 phone TEXT,
 legal_name TEXT,
 registration_no TEXT,
 payout_reference TEXT,
 status TEXT NOT NULL DEFAULT 'pending',
 verified INTEGER DEFAULT 0,
 created_at TEXT,
 updated_at TEXT
);
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 vendor_id INTEGER,
 name TEXT NOT NULL,
 email TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('guest','vendor','admin')),
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT,
 last_login_at TEXT,
 FOREIGN KEY(vendor_id) REFERENCES vendors(id)
);
CREATE TABLE IF NOT EXISTS sessions(
 token_hash TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL,
 expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS vendor_documents(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 vendor_id INTEGER NOT NULL,
 yacht_id INTEGER,
 document_type TEXT NOT NULL,
 reference TEXT,
 file_url TEXT,
 status TEXT NOT NULL DEFAULT 'pending',
 note TEXT,
 uploaded_at TEXT,
 reviewed_at TEXT,
 reviewed_by INTEGER,
 FOREIGN KEY(vendor_id) REFERENCES vendors(id),
 FOREIGN KEY(yacht_id) REFERENCES yachts(id),
 FOREIGN KEY(reviewed_by) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS yachts(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 vendor_id INTEGER NOT NULL,
 name TEXT NOT NULL,
 slug TEXT,
 type TEXT NOT NULL,
 status TEXT DEFAULT 'draft',
 private_enabled INTEGER DEFAULT 1,
 shared_enabled INTEGER DEFAULT 0,
 guests INTEGER DEFAULT 2,
 cabins INTEGER DEFAULT 1,
 crew INTEGER DEFAULT 0,
 length_m REAL DEFAULT 0,
 year_built INTEGER,
 year_refit INTEGER,
 description TEXT,
 image TEXT,
 gallery_json TEXT DEFAULT '[]',
 amenities_json TEXT DEFAULT '[]',
 experiences_json TEXT DEFAULT '[]',
 private_rate REAL,
 shared_rate REAL,
 rating REAL DEFAULT 4.8,
 reviews INTEGER DEFAULT 0,
 verified INTEGER DEFAULT 0,
 verification_note TEXT,
 updated_at TEXT,
 FOREIGN KEY(vendor_id) REFERENCES vendors(id)
);
CREATE TABLE IF NOT EXISTS departures(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 yacht_id INTEGER NOT NULL,
 title TEXT,
 start_date TEXT,
 end_date TEXT,
 nights INTEGER,
 cabins_total INTEGER,
 cabins_available INTEGER,
 price_pp REAL,
 status TEXT DEFAULT 'open',
 FOREIGN KEY(yacht_id) REFERENCES yachts(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS bookings(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 booking_ref TEXT UNIQUE,
 yacht_id INTEGER NOT NULL,
 departure_id INTEGER,
 mode TEXT NOT NULL CHECK(mode IN ('private','shared')),
 guest_name TEXT NOT NULL,
 email TEXT NOT NULL,
 phone TEXT,
 guests INTEGER NOT NULL,
 start_date TEXT,
 end_date TEXT,
 nights INTEGER,
 total_amount REAL NOT NULL DEFAULT 0,
 deposit_percent REAL NOT NULL DEFAULT 100,
 deposit_amount REAL NOT NULL DEFAULT 0,
 amount_paid REAL NOT NULL DEFAULT 0,
 balance_due REAL NOT NULL DEFAULT 0,
 currency TEXT NOT NULL DEFAULT 'USD',
 status TEXT DEFAULT 'pending_operator',
 payment_status TEXT DEFAULT 'unpaid',
 notes TEXT,
 expires_at TEXT,
 created_at TEXT,
 updated_at TEXT,
 FOREIGN KEY(yacht_id) REFERENCES yachts(id),
 FOREIGN KEY(departure_id) REFERENCES departures(id)
);
CREATE TABLE IF NOT EXISTS availability_holds(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 booking_id INTEGER NOT NULL,
 yacht_id INTEGER NOT NULL,
 departure_id INTEGER,
 start_date TEXT,
 end_date TEXT,
 units INTEGER NOT NULL DEFAULT 1,
 expires_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active',
 created_at TEXT NOT NULL,
 FOREIGN KEY(booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
 FOREIGN KEY(yacht_id) REFERENCES yachts(id),
 FOREIGN KEY(departure_id) REFERENCES departures(id)
);
CREATE TABLE IF NOT EXISTS payments(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 booking_id INTEGER NOT NULL,
 provider TEXT NOT NULL DEFAULT 'bml',
 payment_type TEXT NOT NULL DEFAULT 'full',
 provider_reference TEXT,
 checkout_url TEXT,
 amount REAL NOT NULL,
 currency TEXT NOT NULL DEFAULT 'USD',
 commission_rate REAL NOT NULL DEFAULT 30,
 commission_amount REAL NOT NULL DEFAULT 0,
 operator_net_amount REAL NOT NULL DEFAULT 0,
 payout_status TEXT NOT NULL DEFAULT 'pending',
 status TEXT NOT NULL DEFAULT 'created',
 raw_response TEXT,
 created_at TEXT,
 updated_at TEXT,
 FOREIGN KEY(booking_id) REFERENCES bookings(id)
);
CREATE TABLE IF NOT EXISTS refunds(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 payment_id INTEGER NOT NULL,
 booking_id INTEGER NOT NULL,
 amount REAL NOT NULL,
 commission_reversal REAL NOT NULL DEFAULT 0,
 operator_reversal REAL NOT NULL DEFAULT 0,
 reason TEXT,
 status TEXT NOT NULL DEFAULT 'recorded',
 provider_reference TEXT,
 created_at TEXT,
 processed_at TEXT,
 FOREIGN KEY(payment_id) REFERENCES payments(id),
 FOREIGN KEY(booking_id) REFERENCES bookings(id)
);
CREATE TABLE IF NOT EXISTS payouts(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 vendor_id INTEGER NOT NULL,
 amount REAL NOT NULL,
 currency TEXT NOT NULL DEFAULT 'USD',
 status TEXT NOT NULL DEFAULT 'pending',
 reference TEXT,
 notes TEXT,
 created_at TEXT,
 paid_at TEXT,
 FOREIGN KEY(vendor_id) REFERENCES vendors(id)
);
CREATE TABLE IF NOT EXISTS payout_items(
 payout_id INTEGER NOT NULL,
 payment_id INTEGER NOT NULL,
 amount REAL NOT NULL,
 PRIMARY KEY(payout_id,payment_id),
 FOREIGN KEY(payout_id) REFERENCES payouts(id) ON DELETE CASCADE,
 FOREIGN KEY(payment_id) REFERENCES payments(id)
);
CREATE TABLE IF NOT EXISTS platform_settings(
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL,
 updated_at TEXT
);
CREATE TABLE IF NOT EXISTS enquiries(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 yacht_id INTEGER NOT NULL,
 guest_name TEXT NOT NULL,
 email TEXT NOT NULL,
 guests INTEGER,
 experience TEXT,
 message TEXT,
 status TEXT DEFAULT 'new',
 created_at TEXT,
 FOREIGN KEY(yacht_id) REFERENCES yachts(id)
);
CREATE TABLE IF NOT EXISTS notifications(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER,
 vendor_id INTEGER,
 booking_id INTEGER,
 channel TEXT NOT NULL DEFAULT 'in_app',
 recipient TEXT,
 subject TEXT,
 body TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued',
 created_at TEXT NOT NULL,
 sent_at TEXT,
 FOREIGN KEY(user_id) REFERENCES users(id),
 FOREIGN KEY(vendor_id) REFERENCES vendors(id),
 FOREIGN KEY(booking_id) REFERENCES bookings(id)
);
CREATE TABLE IF NOT EXISTS audit_logs(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 actor_user_id INTEGER,
 actor_role TEXT,
 action TEXT NOT NULL,
 entity_type TEXT NOT NULL,
 entity_id TEXT,
 detail_json TEXT,
 created_at TEXT NOT NULL,
 FOREIGN KEY(actor_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_bookings_yacht_dates ON bookings(yacht_id,start_date,end_date,status);
CREATE INDEX IF NOT EXISTS idx_holds_yacht_dates ON availability_holds(yacht_id,start_date,end_date,status);
CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id,status);
CREATE INDEX IF NOT EXISTS idx_notifications_vendor ON notifications(vendor_id,status);
