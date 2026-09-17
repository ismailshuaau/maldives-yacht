ALTER TABLE bookings ADD COLUMN user_id INTEGER REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id,created_at);

CREATE TABLE IF NOT EXISTS wishlists(
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 yacht_id INTEGER NOT NULL REFERENCES yachts(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL,
 PRIMARY KEY(user_id,yacht_id)
);

CREATE TABLE IF NOT EXISTS reviews(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 yacht_id INTEGER NOT NULL REFERENCES yachts(id) ON DELETE CASCADE,
 rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
 title TEXT,
 body TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','hidden')),
 admin_note TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 moderated_at TEXT,
 moderated_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_public ON reviews(status,created_at);

CREATE TABLE IF NOT EXISTS support_requests(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 name TEXT NOT NULL,
 email TEXT NOT NULL,
 phone TEXT,
 subject TEXT NOT NULL,
 message TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','open','waiting','resolved','closed')),
 admin_notes TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_user ON support_requests(user_id,created_at);

CREATE TABLE IF NOT EXISTS support_profiles(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 title TEXT NOT NULL,
 bio TEXT,
 image_url TEXT,
 email TEXT,
 phone TEXT,
 active INTEGER NOT NULL DEFAULT 1,
 sort_order INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trust_marks(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 attribution TEXT NOT NULL,
 image_url TEXT,
 link_url TEXT,
 verified INTEGER NOT NULL DEFAULT 0,
 active INTEGER NOT NULL DEFAULT 1,
 sort_order INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO platform_settings(key,value,updated_at) VALUES
 ('hero_eyebrow','Private yacht charters · liveaboards',CURRENT_TIMESTAMP),
 ('hero_title','Discover the Maldives on a liveaboard',CURRENT_TIMESTAMP),
 ('hero_text','Choose the whole yacht or join a scheduled liveaboard, then shape the experience around you.',CURRENT_TIMESTAMP),
 ('support_always_available','0',CURRENT_TIMESTAMP);
