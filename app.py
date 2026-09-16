#!/usr/bin/env python3
import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).parent
DB = Path(os.environ.get('ATOLLE_DB', ROOT / 'atolle.db'))
SESSION_HOURS = int(os.environ.get('SESSION_HOURS', '24'))
ENFORCE_AUTH = os.environ.get('ENFORCE_AUTH', '0') == '1'
RATE_BUCKET = {}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def parse_date(v):
    if not v:
        return None
    return datetime.strptime(v, '%Y-%m-%d').date()


def json_load(v, fallback=None):
    if fallback is None:
        fallback = []
    try:
        return json.loads(v or '')
    except Exception:
        return fallback


def password_hash(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 210_000)
    return base64.b64encode(salt).decode() + '$' + base64.b64encode(digest).decode()


def password_ok(password, encoded):
    try:
        s, d = encoded.split('$', 1)
        salt = base64.b64decode(s)
        expected = base64.b64decode(d)
        got = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 210_000)
        return hmac.compare_digest(got, expected)
    except Exception:
        return False


SCHEMA = '''
PRAGMA foreign_keys=ON;
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
 places_total INTEGER,
 places_available INTEGER,
 price_pp REAL,
 status TEXT DEFAULT 'open',
 mock_generated INTEGER NOT NULL DEFAULT 0,
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
 cabins_booked INTEGER NOT NULL DEFAULT 0,
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
 cabin_units INTEGER NOT NULL DEFAULT 0,
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
'''


def db_conn():
    c = sqlite3.connect(DB, timeout=15)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA foreign_keys=ON')
    c.execute('PRAGMA journal_mode=WAL')
    return c


def table_cols(c, table):
    return {r['name'] for r in c.execute(f'PRAGMA table_info({table})').fetchall()}


def add_col(c, table, name, ddl):
    if name not in table_cols(c, table):
        c.execute(f'ALTER TABLE {table} ADD COLUMN {name} {ddl}')


def seed_liveaboard_snapshot(c, ts):
    """Add the dated LiveAboard.com demo snapshot without overwriting local edits."""
    path = ROOT / 'mock_data' / 'liveaboard-maldives-april-2028.json'
    if not path.exists():
        return
    snapshot = json.loads(path.read_text(encoding='utf-8'))
    vendor_ids = {}
    for yacht in snapshot.get('yachts', []):
        operator = yacht['operator']
        source_operator_id = str(operator['source_id'])
        if source_operator_id not in vendor_ids:
            registration = 'LIVEABOARD-' + source_operator_id
            row = c.execute('SELECT id FROM vendors WHERE registration_no=?', (registration,)).fetchone()
            if row:
                vendor_ids[source_operator_id] = row['id']
            else:
                cur = c.execute('''INSERT INTO vendors(name,email,legal_name,registration_no,status,verified,created_at,updated_at)
                                   VALUES(?,?,?,?, 'verified',1,?,?)''',
                                (operator['name'], f'liveaboard-{source_operator_id}@mock.atolle.invalid',
                                 operator['name'], registration, ts, ts))
                vendor_ids[source_operator_id] = cur.lastrowid

        slug = 'liveaboard-' + str(yacht['source_id'])
        row = c.execute('SELECT id FROM yachts WHERE slug=?', (slug,)).fetchone()
        if row:
            yacht_id = row['id']
        else:
            cur = c.execute('''INSERT INTO yachts(
                                 vendor_id,name,slug,type,status,private_enabled,shared_enabled,guests,cabins,crew,
                                 length_m,year_built,year_refit,description,image,gallery_json,private_rate,shared_rate,
                                 rating,reviews,verified,verification_note,amenities_json,experiences_json,updated_at)
                               VALUES(?,?,?,?, 'live',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                            (vendor_ids[source_operator_id], yacht['name'], slug, yacht['type'],
                             int(bool(yacht.get('private_enabled'))), int(bool(yacht.get('shared_enabled', True))),
                             yacht['guests'], yacht['cabins'], yacht.get('crew', 0), yacht.get('length_m', 0),
                             yacht.get('year_built'), yacht.get('year_refit'), yacht['description'], yacht['image'],
                             json.dumps(yacht.get('gallery', [])), None, yacht.get('shared_rate'), yacht.get('rating', 0),
                             yacht.get('reviews', 0), 1,
                             f"Mock snapshot from {yacht['source_url']} ({snapshot.get('retrieved_at', '')})",
                             json.dumps(yacht.get('amenities', [])), json.dumps(yacht.get('experiences', [])), ts))
            yacht_id = cur.lastrowid

        for departure in yacht.get('departures', []):
            exists = c.execute('''SELECT 1 FROM departures
                                  WHERE yacht_id=? AND title=? AND start_date=? AND end_date=?''',
                               (yacht_id, departure['title'], departure['start_date'], departure['end_date'])).fetchone()
            if exists:
                continue
            c.execute('''INSERT INTO departures(
                           yacht_id,title,start_date,end_date,nights,cabins_total,cabins_available,
                           places_total,places_available,price_pp,status,mock_generated)
                         VALUES(?,?,?,?,?,?,?,?,?,?,?,0)''',
                      (yacht_id, departure['title'], departure['start_date'], departure['end_date'],
                       departure['nights'], departure['cabins_total'], departure['cabins_available'],
                       departure['places_total'], departure['places_available'], departure['price_pp'], departure['status']))


MOCK_DEPARTURE_TITLE = 'Mock weekly liveaboard schedule'


def month_start_offset(months, today=None):
    today = today or datetime.now(timezone(timedelta(hours=5))).date()
    month_index = today.year * 12 + today.month - 1 + months
    return today.replace(year=month_index // 12, month=month_index % 12 + 1, day=1)


def seed_mock_departures(c, today=None):
    """Maintain rolling weekly demo inventory for imported liveaboards."""
    today = today or datetime.now(timezone(timedelta(hours=5))).date()
    window_start = month_start_offset(0, today)
    next_window = month_start_offset(36, today)
    first_monday = window_start + timedelta(days=(7 - window_start.weekday()) % 7)

    # Generated inventory that can no longer be booked is retained for history.
    c.execute("""UPDATE departures SET status='closed'
                 WHERE mock_generated=1 AND status='open' AND date(end_date)<=date(?)""",
              (today.isoformat(),))

    imported = c.execute("""SELECT id,cabins,guests,shared_rate FROM yachts
                            WHERE slug LIKE 'liveaboard-%' AND shared_enabled=1""").fetchall()
    for yacht in imported:
        start = first_monday
        while start < next_window:
            end = start + timedelta(days=7)
            dates = (start.isoformat(), end.isoformat())
            exists = c.execute("""SELECT 1 FROM departures
                                  WHERE yacht_id=? AND title=? AND start_date=? AND end_date=?""",
                               (yacht['id'], MOCK_DEPARTURE_TITLE, *dates)).fetchone()
            if not exists:
                status = 'closed' if end <= today else 'open'
                c.execute('''INSERT INTO departures(
                               yacht_id,title,start_date,end_date,nights,cabins_total,cabins_available,
                               places_total,places_available,price_pp,status,mock_generated)
                             VALUES(?,?,?,?,7,?,?,?,?,?,?,1)''',
                          (yacht['id'], MOCK_DEPARTURE_TITLE, *dates,
                           yacht['cabins'], yacht['cabins'], yacht['guests'], yacht['guests'],
                           round(float(yacht['shared_rate'] or 0) * 7, 2), status))
            start += timedelta(days=7)


def init_db():
    c = db_conn()
    c.executescript(SCHEMA)
    # Backward-compatible migrations for older project databases.
    for name, ddl in [
        ('phone', 'TEXT'), ('legal_name', 'TEXT'), ('registration_no', 'TEXT'),
        ('payout_reference', 'TEXT'), ('status', "TEXT NOT NULL DEFAULT 'pending'"),
        ('created_at', 'TEXT'), ('updated_at', 'TEXT')]:
        add_col(c, 'vendors', name, ddl)
    for name, ddl in [('slug','TEXT')]:
        add_col(c, 'yachts', name, ddl)
    for name, ddl in [
        ('booking_ref','TEXT'), ('phone','TEXT'), ('nights','INTEGER'),
        ('cabins_booked','INTEGER NOT NULL DEFAULT 0'),
        ('total_amount','REAL NOT NULL DEFAULT 0'), ('deposit_percent','REAL NOT NULL DEFAULT 100'),
        ('deposit_amount','REAL NOT NULL DEFAULT 0'), ('amount_paid','REAL NOT NULL DEFAULT 0'),
        ('balance_due','REAL NOT NULL DEFAULT 0'), ('currency',"TEXT NOT NULL DEFAULT 'USD'"),
        ('payment_status',"TEXT DEFAULT 'unpaid'"), ('expires_at','TEXT'), ('updated_at','TEXT')]:
        add_col(c, 'bookings', name, ddl)
    departure_cols=table_cols(c, 'departures')
    added_places_total='places_total' not in departure_cols
    added_places_available='places_available' not in departure_cols
    add_col(c, 'departures', 'places_total', 'INTEGER')
    add_col(c, 'departures', 'places_available', 'INTEGER')
    add_col(c, 'departures', 'mock_generated', 'INTEGER NOT NULL DEFAULT 0')
    c.execute('''CREATE INDEX IF NOT EXISTS idx_departures_yacht_schedule
                 ON departures(yacht_id,status,mock_generated,start_date)''')
    add_col(c, 'availability_holds', 'cabin_units', 'INTEGER NOT NULL DEFAULT 0')
    if added_places_total or added_places_available:
        c.execute('''UPDATE departures
                     SET places_total=COALESCE(places_total,(SELECT guests FROM yachts WHERE yachts.id=departures.yacht_id),0),
                         places_available=COALESCE(places_available,MIN(
                           COALESCE((SELECT guests FROM yachts WHERE yachts.id=departures.yacht_id),0),
                           COALESCE(cabins_available,0)*2
                         ))''')
    # Legacy bookings used amount; copy it once into total_amount where needed.
    if 'amount' in table_cols(c, 'bookings'):
        c.execute('UPDATE bookings SET total_amount=COALESCE(NULLIF(total_amount,0),amount,0)')
    for name, ddl in [
        ('payment_type',"TEXT NOT NULL DEFAULT 'full'"),
        ('commission_rate','REAL NOT NULL DEFAULT 30'), ('commission_amount','REAL NOT NULL DEFAULT 0'),
        ('operator_net_amount','REAL NOT NULL DEFAULT 0'), ('payout_status',"TEXT NOT NULL DEFAULT 'pending'")]:
        add_col(c, 'payments', name, ddl)

    ts = now_iso()
    defaults = {'commission_rate':'30','deposit_percent':'30','hold_minutes':'30','currency':'USD'}
    for k,v in defaults.items():
        c.execute('INSERT OR IGNORE INTO platform_settings(key,value,updated_at) VALUES(?,?,?)', (k,v,ts))

    if c.execute('SELECT COUNT(*) FROM vendors').fetchone()[0] == 0:
        cur = c.execute('''INSERT INTO vendors(name,email,legal_name,registration_no,status,verified,created_at,updated_at)
                           VALUES(?,?,?,?, 'verified',1,?,?)''',
                        ('Blue Horizon Maldives','operator@example.com','Blue Horizon Maldives Pvt Ltd','C-0000/2026',ts,ts))
        vendor_id = cur.lastrowid
        yachts = [
          ('Ocean Pearl','Luxury Motor Yacht','live',1,0,10,5,12,44.0,2019,2025,'A refined private yacht for families and groups, with generous deck space, a private chef and a full collection of water toys.','https://images.unsplash.com/photo-1540946485063-a40da27545f8?auto=format&fit=crop&w=1400&q=85',14500,None,4.9,41,1,['Jacuzzi','Wi-Fi','Private chef','Jet ski','Seabob'],['Luxury escape','Honeymoon','Family holiday']),
          ('Azure Spirit','Luxury Liveaboard','live',1,1,22,11,16,52.0,2021,2026,'A premium liveaboard with private-charter capability, designed for diving, wellness and longer Maldives journeys.','https://images.unsplash.com/photo-1562281302-809108fd533c?auto=format&fit=crop&w=1400&q=85',18000,395,4.9,87,1,['Nitrox','Spa','Wi-Fi','Dive dhoni','Kayaks'],['Diving','Wellness & spa','Liveaboard']),
          ('Manta One','Explorer Yacht','draft',1,0,12,6,11,38.5,2018,2024,'A flexible explorer yacht for private adventures, fishing and remote-island experiences.','https://images.unsplash.com/photo-1549402906-186949f5c60b?auto=format&fit=crop&w=1400&q=85',8500,None,4.8,18,0,['Fishing gear','Paddleboards','Wi-Fi'],['Fishing','Adventure','Private island hopping'])
        ]
        ids=[]
        for y in yachts:
            (name,typ,status,pe,se,guests,cabins,crew,l,year,refit,desc,img,pr,sr,rating,reviews,ver,amen,exp)=y
            slug='-'.join(name.lower().split())
            cur=c.execute('''INSERT INTO yachts(vendor_id,name,slug,type,status,private_enabled,shared_enabled,guests,cabins,crew,length_m,year_built,year_refit,description,image,private_rate,shared_rate,rating,reviews,verified,amenities_json,experiences_json,updated_at)
                         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
              (vendor_id,name,slug,typ,status,pe,se,guests,cabins,crew,l,year,refit,desc,img,pr,sr,rating,reviews,ver,json.dumps(amen),json.dumps(exp),ts))
            ids.append(cur.lastrowid)
        c.execute('''INSERT INTO departures(yacht_id,title,start_date,end_date,nights,cabins_total,cabins_available,places_total,places_available,price_pp)
                     VALUES(?,?,?,?,?,?,?,?,?,?)''',(ids[1],'Maldives Explorer','2026-11-14','2026-11-21',7,11,6,22,12,2395))
        c.execute('''INSERT INTO departures(yacht_id,title,start_date,end_date,nights,cabins_total,cabins_available,places_total,places_available,price_pp)
                     VALUES(?,?,?,?,?,?,?,?,?,?)''',(ids[1],'Dive & Wellness Week','2026-11-22','2026-11-29',7,11,4,22,8,2595))
    else:
        vendor_id = c.execute('SELECT id FROM vendors ORDER BY id LIMIT 1').fetchone()[0]

    seed_liveaboard_snapshot(c, ts)
    seed_mock_departures(c)

    # Seed demo users if missing. Passwords are intentionally documented demo credentials.
    demo_users=[
        ('Platform Admin','admin@atolle.mv','admin','AtolleAdmin123!',None),
        ('Blue Horizon Operator','operator@example.com','vendor','AtolleVendor123!',vendor_id),
        ('Demo Guest','guest@example.com','guest','AtolleGuest123!',None),
    ]
    for name,email,role,pw,vid in demo_users:
        if not c.execute('SELECT 1 FROM users WHERE email=?',(email,)).fetchone():
            c.execute('INSERT INTO users(vendor_id,name,email,password_hash,role,active,created_at) VALUES(?,?,?,?,?,1,?)',
                      (vid,name,email,password_hash(pw),role,ts))
    c.commit(); c.close()


def setting(c, key, default=None, as_float=False):
    row=c.execute('SELECT value FROM platform_settings WHERE key=?',(key,)).fetchone()
    v=row['value'] if row else default
    if as_float:
        try:return float(v)
        except:return float(default or 0)
    return v


def set_setting(c,key,value):
    c.execute('''INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,?)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at''',
              (key,str(value),now_iso()))


def rowdict(row):
    if not row:return None
    d=dict(row)
    for k in ('amenities_json','experiences_json','gallery_json','detail_json','raw_response'):
        if k in d:
            parsed=json_load(d.get(k), {} if k in ('detail_json','raw_response') else [])
            if k.endswith('_json'):d[k[:-5]]=parsed
            else:d[k]=parsed
            if k.endswith('_json'):d.pop(k,None)
    for k in ('private_enabled','shared_enabled','mock_generated','verified','active'):
        if k in d:d[k]=bool(d[k])
    if isinstance(d.get('experiences'),list):
        d['experiences']=['Liveaboard' if str(value).lower()=='shared liveaboard' else value for value in d['experiences']]
    return d


def audit(c, actor, action, entity_type, entity_id=None, detail=None):
    c.execute('INSERT INTO audit_logs(actor_user_id,actor_role,action,entity_type,entity_id,detail_json,created_at) VALUES(?,?,?,?,?,?,?)',
              ((actor or {}).get('id'),(actor or {}).get('role','system'),action,entity_type,str(entity_id) if entity_id is not None else None,json.dumps(detail or {}),now_iso()))


def notify(c, body, subject=None, user_id=None, vendor_id=None, booking_id=None, recipient=None, channel='in_app'):
    c.execute('INSERT INTO notifications(user_id,vendor_id,booking_id,channel,recipient,subject,body,status,created_at) VALUES(?,?,?,?,?,?,?,\'queued\',?)',
              (user_id,vendor_id,booking_id,channel,recipient,subject,body,now_iso()))


def clean_expired_holds(c):
    c.execute("UPDATE availability_holds SET status='expired' WHERE status='active' AND expires_at < ?",(now_iso(),))


def overlap_exists(c,yacht_id,start_date,end_date,exclude_booking=None):
    clean_expired_holds(c)
    sql="""SELECT 1 FROM availability_holds h
           WHERE h.yacht_id=? AND h.status='active' AND h.departure_id IS NULL
           AND date(h.start_date) < date(?) AND date(h.end_date) > date(?)"""
    vals=[yacht_id,end_date,start_date]
    if exclude_booking:
        sql+=' AND h.booking_id<>?';vals.append(exclude_booking)
    return bool(c.execute(sql,vals).fetchone())


class BookingSelectionError(Exception):
    def __init__(self,message,status=400):
        super().__init__(message);self.status=status


def booking_selection(c,data,lock=False):
    yacht=rowdict(c.execute('SELECT * FROM yachts WHERE id=?',(data.get('yacht_id'),)).fetchone())
    if not yacht:raise BookingSelectionError('Yacht not found',404)
    mode=data.get('mode')
    if mode not in ('private','shared'):raise BookingSelectionError('mode must be private or shared')
    try:
        if mode=='shared' and ('guests' not in data or 'cabins_booked' not in data):raise ValueError()
        guests=int(data.get('guests') or 1)
        if guests<1:raise ValueError()
    except (TypeError,ValueError):raise BookingSelectionError('A valid guest count is required')
    if lock:c.execute('BEGIN IMMEDIATE')
    departure_id=data.get('departure_id') or None;start=data.get('start_date');end=data.get('end_date');nights=0;total=0.0;cabins_booked=0;departure=None
    if mode=='private':
        if not yacht['private_enabled']:raise BookingSelectionError('Private charter unavailable',409)
        try:
            sd,ed=parse_date(start),parse_date(end)
            if not sd or not ed or ed<=sd:raise ValueError()
        except (TypeError,ValueError):raise BookingSelectionError('Valid start_date and end_date are required')
        nights=(ed-sd).days
        if guests>int(yacht['guests']):raise BookingSelectionError('Guest count exceeds yacht capacity')
        if overlap_exists(c,yacht['id'],start,end):raise BookingSelectionError('These dates are no longer available',409)
        total=round(float(yacht['private_rate'] or 0)*nights,2);departure_id=None
    else:
        if not yacht['shared_enabled']:raise BookingSelectionError('Liveaboard unavailable',409)
        try:
            cabins_booked=int(data.get('cabins_booked'))
            if cabins_booked<1 or cabins_booked>guests:raise ValueError()
        except (TypeError,ValueError):raise BookingSelectionError('Cabins must be between one and the number of guests')
        if lock:clean_expired_holds(c)
        departure=rowdict(c.execute("SELECT * FROM departures WHERE id=? AND yacht_id=? AND status='open'",(departure_id,yacht['id'])).fetchone())
        if not departure:raise BookingSelectionError('Liveaboard departure not found',404)
        reserved=c.execute("""SELECT COALESCE(SUM(units),0) places,COALESCE(SUM(cabin_units),0) cabins
                              FROM availability_holds WHERE departure_id=? AND status='active' AND expires_at>?""",(departure_id,now_iso())).fetchone()
        places_remaining=max(0,int(departure['places_available'] or 0)-int(reserved['places'] or 0))
        cabins_remaining=max(0,int(departure['cabins_available'] or 0)-int(reserved['cabins'] or 0))
        if guests>places_remaining:raise BookingSelectionError('Not enough passenger places remain',409)
        if cabins_booked>cabins_remaining:raise BookingSelectionError('Not enough cabins remain',409)
        start,end,nights=departure['start_date'],departure['end_date'],departure['nights'];total=round(float(departure['price_pp'] or 0)*guests,2)
    deposit_percent=max(0,min(100,float(setting(c,'deposit_percent','30',True))))
    deposit=round(total*deposit_percent/100,2);currency=setting(c,'currency','USD')
    return {'yacht':yacht,'departure':departure,'departure_id':departure_id,'mode':mode,'guests':guests,'cabins_booked':cabins_booked,
            'start_date':start,'end_date':end,'nights':nights,'total_amount':total,'deposit_percent':deposit_percent,
            'deposit_amount':deposit,'balance_amount':round(total-deposit,2),'currency':currency}


def public_quote(selection):
    quote={k:v for k,v in selection.items() if k not in ('yacht','departure')}
    quote['total']=quote['total_amount'];quote['balance']=quote['balance_amount']
    return quote


def model_flags(data, existing=None):
    private_enabled=bool(data.get('private_enabled', existing.get('private_enabled') if existing else False))
    shared_enabled=bool(data.get('shared_enabled', existing.get('shared_enabled') if existing else False))
    if not private_enabled and not shared_enabled:
        raise ValueError('At least one booking model must be enabled')
    return int(private_enabled),int(shared_enabled)


def departure_values(data):
    try:
        start=parse_date(data.get('start_date'));end=parse_date(data.get('end_date'))
        if not start or not end or end<=start:raise ValueError('End date must follow start date')
        values={k:int(data.get(k) or 0) for k in ('nights','cabins_total','cabins_available','places_total','places_available')}
        values['price_pp']=float(data.get('price_pp') or 0)
    except (TypeError, ValueError) as e:
        message=str(e) if str(e) else 'Departure dates and inventory must be valid numbers'
        raise ValueError(message)
    if any(v<0 for v in values.values()):raise ValueError('Duration, inventory, and price must be non-negative')
    if values['cabins_available']>values['cabins_total']:raise ValueError('Available cabins cannot exceed total cabins')
    if values['places_available']>values['places_total']:raise ValueError('Available places cannot exceed total places')
    status=data.get('status','open')
    if status not in ('open','closed'):raise ValueError('Departure status must be open or closed')
    return {**values,'title':data.get('title'),'start_date':data.get('start_date'),'end_date':data.get('end_date'),'status':status}


def departure_dict(c, row, include_effective=True):
    dep=rowdict(row)
    if not dep or not include_effective:return dep
    clean_expired_holds(c)
    reserved=c.execute("""SELECT COALESCE(SUM(units),0) places,COALESCE(SUM(cabin_units),0) cabins
                          FROM availability_holds WHERE departure_id=? AND status='active' AND expires_at>?""",
                       (dep['id'],now_iso())).fetchone()
    dep['places_remaining']=max(0,int(dep.get('places_available') or 0)-int(reserved['places'] or 0))
    dep['cabins_remaining']=max(0,int(dep.get('cabins_available') or 0)-int(reserved['cabins'] or 0))
    return dep


def bml_config():
    env=os.environ.get('BML_ENV','sandbox').lower()
    return {
        'mode':os.environ.get('BML_MODE','mock').lower(),
        'environment':env,
        'base_url':os.environ.get('BML_BASE_URL') or ('https://api.merchants.bankofmaldives.com.mv/public/' if env=='production' else 'https://api.uat.merchants.bankofmaldives.com.mv/public/'),
        'api_key':os.environ.get('BML_API_KEY',''),
        'app_id':os.environ.get('BML_APP_ID',''),
        'return_url':os.environ.get('BML_RETURN_URL','http://localhost:8000/payment-return.html'),
        'currency':os.environ.get('BML_CURRENCY','USD').upper(),
    }


def bml_minor_units(amount):return int(round(float(amount)*100))

def bml_signature(amount_minor,currency,api_key):
    return hashlib.sha1(f'amount={amount_minor}&currency={currency}&apiKey={api_key}'.encode()).hexdigest()


def create_bml_payment(booking,payment_id,amount):
    cfg=bml_config()
    if cfg['mode']!='live':
        ref='BML-DEMO-'+secrets.token_hex(5).upper()
        return {'provider_reference':ref,'checkout_url':f'/payment-return.html?payment_id={payment_id}&demo=1','status':'pending','raw':{'mode':'mock','reference':ref}}
    if not cfg['api_key']:raise RuntimeError('BML live mode is not configured: BML_API_KEY is missing')
    currency=booking.get('currency') or cfg['currency']; minor=bml_minor_units(amount)
    payload={'currency':currency,'amount':minor,'localId':f'PAYMENT-{payment_id}','redirectUrl':cfg['return_url']+('?payment_id='+str(payment_id)),
             'signature':bml_signature(minor,currency,cfg['api_key']),'apiVersion':'2.0','appVersion':'atolle-python','signMethod':'sha1'}
    req=urllib.request.Request(cfg['base_url'].rstrip('/')+'/transactions',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','Accept':'application/json','Authorization':cfg['api_key']},method='POST')
    try:
        with urllib.request.urlopen(req,timeout=20) as r:body=json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'BML HTTP {e.code}: {e.read().decode(errors="replace")[:500]}')
    url=body.get('url');ref=body.get('id') or body.get('transactionId') or body.get('reference') or body.get('localId') or payload['localId']
    if not url:raise RuntimeError('BML Connect response did not include a payment URL')
    return {'provider_reference':str(ref),'checkout_url':str(url),'status':'pending','raw':body}


def bml_get_transaction(reference):
    cfg=bml_config()
    if cfg['mode']!='live':return {'id':reference,'status':'pending','mode':'mock'}
    if not cfg['api_key']:raise RuntimeError('BML_API_KEY missing')
    req=urllib.request.Request(cfg['base_url'].rstrip('/')+'/transactions/'+urllib.parse.quote(str(reference)),headers={'Accept':'application/json','Authorization':cfg['api_key']})
    try:
        with urllib.request.urlopen(req,timeout=20) as r:return json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'BML HTTP {e.code}: {e.read().decode(errors="replace")[:500]}')


def normalized_bml_status(body):
    raw=str(body.get('status') or body.get('state') or '').lower()
    if raw in ('paid','success','successful','completed','complete','approved'):return 'paid'
    if raw in ('failed','declined','error'):return 'failed'
    if raw in ('cancelled','canceled','void'):return 'cancelled'
    return 'pending'


def sync_booking_totals(c, booking_id):
    paid=c.execute("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE booking_id=? AND status='paid'",(booking_id,)).fetchone()['s'] or 0
    refunded=c.execute("SELECT COALESCE(SUM(amount),0) s FROM refunds WHERE booking_id=? AND status IN ('recorded','processed')",(booking_id,)).fetchone()['s'] or 0
    b=c.execute('SELECT total_amount FROM bookings WHERE id=?',(booking_id,)).fetchone()
    if not b:return
    net=max(0,float(paid)-float(refunded));total=float(b['total_amount'] or 0);balance=max(0,total-net)
    ps='paid' if total>0 and balance<=0.009 else ('partial' if net>0 else 'unpaid')
    c.execute('UPDATE bookings SET amount_paid=?,balance_due=?,payment_status=?,updated_at=? WHERE id=?',(round(net,2),round(balance,2),ps,now_iso(),booking_id))


def payment_amount_for_booking(c,b,payment_type):
    sync_booking_totals(c,b['id'])
    b=rowdict(c.execute('SELECT * FROM bookings WHERE id=?',(b['id'],)).fetchone())
    if payment_type=='deposit':
        remaining_deposit=max(0,float(b['deposit_amount'])-float(b['amount_paid']))
        return round(remaining_deposit,2)
    if payment_type=='balance':return round(float(b['balance_due']),2)
    return round(float(b['balance_due']),2)


def payment_mark(c,payment_id,status,raw=None,actor=None):
    p=rowdict(c.execute('SELECT * FROM payments WHERE id=?',(payment_id,)).fetchone())
    if not p:return None
    if p['status']=='paid' and status!='paid':return p
    c.execute('UPDATE payments SET status=?,raw_response=COALESCE(?,raw_response),updated_at=? WHERE id=?',(status,json.dumps(raw) if raw is not None else None,now_iso(),payment_id))
    if status=='paid':
        c.execute("UPDATE bookings SET status=CASE WHEN status IN ('pending_operator','approved','awaiting_payment') THEN 'confirmed' ELSE status END WHERE id=?",(p['booking_id'],))
        c.execute("UPDATE availability_holds SET expires_at=?,status='active' WHERE booking_id=?",((datetime.now(timezone.utc)+timedelta(days=365)).isoformat(),p['booking_id']))
    sync_booking_totals(c,p['booking_id'])
    audit(c,actor,'payment_status_changed','payment',payment_id,{'status':status})
    return rowdict(c.execute('SELECT * FROM payments WHERE id=?',(payment_id,)).fetchone())


def current_user(c,auth_header):
    if not auth_header or not auth_header.lower().startswith('bearer '):return None
    token=auth_header.split(' ',1)[1].strip();th=hashlib.sha256(token.encode()).hexdigest()
    r=c.execute('''SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
                   WHERE s.token_hash=? AND s.expires_at>? AND u.active=1''',(th,now_iso())).fetchone()
    return rowdict(r)


def issue_session(c,user_id):
    token=secrets.token_urlsafe(36);th=hashlib.sha256(token.encode()).hexdigest();exp=datetime.now(timezone.utc)+timedelta(hours=SESSION_HOURS)
    c.execute('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)',(th,user_id,exp.isoformat(),now_iso()))
    return token,exp.isoformat()


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','strict-origin-when-cross-origin')
        self.send_header('X-Frame-Options','DENY')
        self.send_header('Permissions-Policy','camera=(), microphone=(), geolocation=()')
        self.send_header('Content-Security-Policy',"default-src 'self' https: data:; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https://api.merchants.bankofmaldives.com.mv https://api.uat.merchants.bankofmaldives.com.mv")
        if not self.path.startswith('/api/'):
            self.send_header('Cache-Control','no-cache')
        super().end_headers()
    def rate_ok(self, limit=120, seconds=60):
        key=self.client_address[0];now=datetime.now(timezone.utc).timestamp();arr=[t for t in RATE_BUCKET.get(key,[]) if now-t<seconds]
        if len(arr)>=limit:return False
        arr.append(now);RATE_BUCKET[key]=arr;return True
    def __init__(self,*a,**kw):super().__init__(*a,directory=str(ROOT),**kw)
    def send_json(self,obj,status=200):
        body=json.dumps(obj,default=str).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def read_json(self):
        n=int(self.headers.get('Content-Length','0') or 0)
        try:return json.loads(self.rfile.read(n) or b'{}')
        except:return {}
    def actor(self,c):return current_user(c,self.headers.get('Authorization'))
    def require(self,c,roles):
        u=self.actor(c)
        if u and u['role'] in roles:return u
        if not ENFORCE_AUTH:
            # Demo compatibility: protected mutations remain usable locally.
            return {'id':None,'role':'admin' if 'admin' in roles else ('vendor' if 'vendor' in roles else 'guest'),'vendor_id':1 if 'vendor' in roles else None,'name':'Demo mode'}
        self.send_json({'error':'Authentication required','roles':roles},401);return None
    def do_GET(self):
        u=urllib.parse.urlparse(self.path);q=urllib.parse.parse_qs(u.query)
        if not u.path.startswith('/api/'):return super().do_GET()
        c=db_conn()
        try:
            if u.path=='/api/health':self.send_json({'ok':True,'time':now_iso(),'auth_enforced':ENFORCE_AUTH});return
            if u.path=='/api/auth/me':
                me=self.actor(c);self.send_json(me or {'authenticated':False},200 if me else 401);return
            if u.path=='/api/yachts':
                where=[];vals=[]
                if q.get('vendor_id'):where.append('vendor_id=?');vals.append(q['vendor_id'][0])
                if q.get('status'):where.append('status=?');vals.append(q['status'][0])
                if q.get('q'):
                    where.append('(name LIKE ? OR type LIKE ? OR description LIKE ?)');s='%'+q['q'][0]+'%';vals += [s,s,s]
                sql='SELECT * FROM yachts'+((' WHERE '+' AND '.join(where)) if where else '')+' ORDER BY verified DESC,rating DESC,id DESC'
                yachts=[rowdict(r) for r in c.execute(sql,vals).fetchall()]
                mode=(q.get('mode') or [''])[0].lower()
                if not mode:
                    self.send_json(yachts);return
                if mode not in ('private','shared'):
                    self.send_json({'error':'mode must be private or shared'},400);return
                start=(q.get('start') or [None])[0];end=(q.get('end') or [None])[0]
                if bool(start)!=bool(end):
                    self.send_json({'error':'start and end must be provided together'},400);return
                if start and end:
                    try:
                        sd,ed=parse_date(start),parse_date(end)
                        if not sd or not ed or ed<=sd:raise ValueError()
                    except:
                        self.send_json({'error':'Valid start and end dates are required'},400);return
                try:guests=max(1,int((q.get('guests') or ['1'])[0]))
                except:guests=1
                yacht_type=(q.get('type') or [''])[0].strip().lower()
                experience=(q.get('experience') or [''])[0].strip().lower()
                try:duration_min=max(0,int((q.get('duration_min') or ['0'])[0]))
                except:duration_min=0
                try:duration_max=max(0,int((q.get('duration_max') or ['0'])[0]))
                except:duration_max=0
                results=[];ts=now_iso()
                for yacht in yachts:
                    if yacht_type and str(yacht.get('type') or '').lower()!=yacht_type:continue
                    if experience and experience not in [str(x).lower() for x in yacht.get('experiences',[])]:continue
                    if mode=='private':
                        if not yacht.get('private_enabled') or guests>int(yacht.get('guests') or 0):continue
                        if start and overlap_exists(c,yacht['id'],start,end):continue
                        results.append(yacht);continue
                    if not yacht.get('shared_enabled'):continue
                    matches=[]
                    departures=c.execute("""SELECT * FROM departures WHERE yacht_id=? AND status='open'
                                            ORDER BY mock_generated ASC,start_date,id""",(yacht['id'],)).fetchall()
                    for row in departures:
                        dep=departure_dict(c,row);nights=int(dep.get('nights') or 0)
                        if start and (dep.get('start_date')>end or dep.get('end_date')<start):continue
                        if duration_min and nights<duration_min:continue
                        if duration_max and nights>duration_max:continue
                        if dep['places_remaining']<guests or dep['cabins_remaining']<1:continue
                        dep['available_units']=dep['places_remaining'];matches.append(dep)
                    if matches:
                        yacht['matching_departures']=matches;results.append(yacht)
                self.send_json(results);return
            if u.path.startswith('/api/yachts/') and not u.path.endswith('/availability'):
                i=u.path.split('/')[3];y=rowdict(c.execute('SELECT * FROM yachts WHERE id=?',(i,)).fetchone())
                if not y:self.send_json({'error':'Not found'},404);return
                y['departures']=[departure_dict(c,r) for r in c.execute("""SELECT * FROM departures WHERE yacht_id=? AND status='open'
                                                                           ORDER BY mock_generated ASC,start_date,id""",(i,)).fetchall()]
                self.send_json(y);return
            if u.path.endswith('/availability') and u.path.startswith('/api/yachts/'):
                i=u.path.split('/')[3];start=(q.get('start') or [None])[0];end=(q.get('end') or [None])[0]
                if not start or not end:self.send_json({'error':'start and end are required'},400);return
                self.send_json({'available':not overlap_exists(c,i,start,end)});return
            if u.path=='/api/bookings':
                actor=self.require(c,['vendor','admin']);
                if not actor:return
                sql='''SELECT b.*,y.name yacht_name,y.vendor_id,d.title departure_title,
                       d.start_date departure_start_date,d.end_date departure_end_date
                       FROM bookings b JOIN yachts y ON y.id=b.yacht_id
                       LEFT JOIN departures d ON d.id=b.departure_id''';vals=[]
                if actor.get('role')=='vendor' and actor.get('vendor_id'):
                    sql+=' WHERE y.vendor_id=?';vals.append(actor['vendor_id'])
                sql+=' ORDER BY b.id DESC';self.send_json([rowdict(r) for r in c.execute(sql,vals).fetchall()]);return
            if u.path=='/api/departures':
                actor=self.require(c,['vendor','admin']);
                if not actor:return
                sql='''SELECT d.*,y.name yacht_name,y.vendor_id FROM departures d JOIN yachts y ON y.id=d.yacht_id''';vals=[]
                include_generated=(q.get('include_generated') or ['1'])[0]
                if include_generated not in ('0','1'):
                    self.send_json({'error':'include_generated must be 0 or 1'},400);return
                where=[]
                if include_generated=='0':where.append('d.mock_generated=0')
                if actor.get('role')=='vendor' and actor.get('vendor_id'):
                    where.append('y.vendor_id=?');vals.append(actor['vendor_id'])
                if where:sql+=' WHERE '+' AND '.join(where)
                sql+=' ORDER BY d.start_date DESC,d.id DESC'
                self.send_json([departure_dict(c,r) for r in c.execute(sql,vals).fetchall()]);return
            if u.path.startswith('/api/bookings/'):
                i=u.path.split('/')[3];b=rowdict(c.execute('''SELECT b.*,y.name yacht_name,y.vendor_id FROM bookings b JOIN yachts y ON y.id=b.yacht_id WHERE b.id=?''',(i,)).fetchone())
                if not b:self.send_json({'error':'Not found'},404);return
                b['payments']=[rowdict(r) for r in c.execute('SELECT * FROM payments WHERE booking_id=? ORDER BY id',(i,)).fetchall()]
                b['refunds']=[rowdict(r) for r in c.execute('SELECT * FROM refunds WHERE booking_id=? ORDER BY id',(i,)).fetchall()]
                self.send_json(b);return
            if u.path=='/api/payments':
                actor=self.require(c,['vendor','admin']);
                if not actor:return
                sql='''SELECT p.*,b.guest_name,y.name yacht_name,y.vendor_id FROM payments p JOIN bookings b ON b.id=p.booking_id JOIN yachts y ON y.id=b.yacht_id''';vals=[]
                if actor.get('role')=='vendor' and actor.get('vendor_id'):
                    sql+=' WHERE y.vendor_id=?';vals.append(actor['vendor_id'])
                sql+=' ORDER BY p.id DESC';self.send_json([rowdict(r) for r in c.execute(sql,vals).fetchall()]);return
            if u.path.startswith('/api/payments/'):
                i=u.path.split('/')[3];p=rowdict(c.execute('SELECT * FROM payments WHERE id=?',(i,)).fetchone());self.send_json(p or {'error':'Not found'},200 if p else 404);return
            if u.path=='/api/payment/config':
                cfg=bml_config();self.send_json({'provider':'bml','mode':cfg['mode'],'environment':cfg['environment'],'currency':cfg['currency'],'live_configured':bool(cfg['api_key'])});return
            if u.path=='/api/admin/settings':
                if not self.require(c,['admin']):return
                rows=c.execute('SELECT key,value,updated_at FROM platform_settings').fetchall();self.send_json({r['key']:r['value'] for r in rows});return
            if u.path=='/api/enquiries':
                if not self.require(c,['vendor','admin']):return
                self.send_json([rowdict(r) for r in c.execute('SELECT e.*,y.name yacht_name,y.vendor_id FROM enquiries e JOIN yachts y ON y.id=e.yacht_id ORDER BY e.id DESC').fetchall()]);return
            if u.path=='/api/admin/stats':
                if not self.require(c,['admin']):return
                self.send_json({'yachts':c.execute('SELECT COUNT(*) FROM yachts').fetchone()[0],'live':c.execute("SELECT COUNT(*) FROM yachts WHERE status='live'").fetchone()[0],
                    'private_enabled':c.execute('SELECT COUNT(*) FROM yachts WHERE private_enabled=1').fetchone()[0],
                    'shared_enabled':c.execute('SELECT COUNT(*) FROM yachts WHERE shared_enabled=1').fetchone()[0],
                    'pending_verification':c.execute('SELECT COUNT(*) FROM yachts WHERE verified=0').fetchone()[0],'bookings':c.execute('SELECT COUNT(*) FROM bookings').fetchone()[0],
                    'enquiries':c.execute('SELECT COUNT(*) FROM enquiries').fetchone()[0],'vendors_pending':c.execute("SELECT COUNT(*) FROM vendors WHERE verified=0").fetchone()[0]});return
            if u.path=='/api/admin/vendors':
                if not self.require(c,['admin']):return
                self.send_json([rowdict(r) for r in c.execute('SELECT * FROM vendors ORDER BY id DESC').fetchall()]);return
            if u.path=='/api/vendor/documents':
                actor=self.require(c,['vendor','admin']);
                if not actor:return
                sql='SELECT * FROM vendor_documents';vals=[]
                if actor.get('role')=='vendor' and actor.get('vendor_id'):sql+=' WHERE vendor_id=?';vals=[actor['vendor_id']]
                sql+=' ORDER BY id DESC';self.send_json([rowdict(r) for r in c.execute(sql,vals).fetchall()]);return
            if u.path=='/api/admin/ledger':
                if not self.require(c,['admin']):return
                self.send_json([rowdict(r) for r in c.execute('''SELECT v.id vendor_id,v.name,
                    COALESCE(SUM(CASE WHEN p.status='paid' THEN p.operator_net_amount ELSE 0 END),0)-
                    COALESCE((SELECT SUM(r.operator_reversal) FROM refunds r JOIN payments rp ON rp.id=r.payment_id JOIN bookings rb ON rb.id=rp.booking_id JOIN yachts ry ON ry.id=rb.yacht_id WHERE ry.vendor_id=v.id AND r.status IN ('recorded','processed')),0)-
                    COALESCE((SELECT SUM(po.amount) FROM payouts po WHERE po.vendor_id=v.id AND po.status IN ('pending','paid')),0) available_balance
                    FROM vendors v LEFT JOIN yachts y ON y.vendor_id=v.id LEFT JOIN bookings b ON b.yacht_id=y.id LEFT JOIN payments p ON p.booking_id=b.id GROUP BY v.id,v.name ORDER BY v.id''').fetchall()]);return
            if u.path=='/api/admin/payouts':
                if not self.require(c,['admin']):return
                self.send_json([rowdict(r) for r in c.execute('SELECT p.*,v.name vendor_name FROM payouts p JOIN vendors v ON v.id=p.vendor_id ORDER BY p.id DESC').fetchall()]);return
            if u.path=='/api/notifications':
                actor=self.require(c,['vendor','admin']);
                if not actor:return
                sql='SELECT * FROM notifications';vals=[]
                if actor.get('role')=='vendor' and actor.get('vendor_id'):sql+=' WHERE vendor_id=?';vals=[actor['vendor_id']]
                sql+=' ORDER BY id DESC LIMIT 100';self.send_json([rowdict(r) for r in c.execute(sql,vals).fetchall()]);return
            if u.path=='/api/admin/audit':
                if not self.require(c,['admin']):return
                self.send_json([rowdict(r) for r in c.execute('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200').fetchall()]);return
            self.send_json({'error':'Unknown endpoint'},404)
        finally:c.close()

    def do_POST(self):
        u=urllib.parse.urlparse(self.path)
        if not u.path.startswith('/api/'):self.send_json({'error':'API only'},404);return
        if not self.rate_ok():self.send_json({'error':'Too many requests'},429);return
        data=self.read_json();c=db_conn();ts=now_iso()
        try:
            if u.path=='/api/auth/register':
                email=str(data.get('email','')).strip().lower();name=str(data.get('name','')).strip();pw=str(data.get('password',''))
                if not name or '@' not in email or len(pw)<10:self.send_json({'error':'Name, valid email and password of at least 10 characters are required'},400);return
                if c.execute('SELECT 1 FROM users WHERE lower(email)=lower(?)',(email,)).fetchone():self.send_json({'error':'Email already registered'},409);return
                cur=c.execute('INSERT INTO users(name,email,password_hash,role,active,created_at) VALUES(?,?,?,?,1,?)',(name,email,password_hash(pw),'guest',ts));token,exp=issue_session(c,cur.lastrowid);audit(c,{'id':cur.lastrowid,'role':'guest'},'register','user',cur.lastrowid);c.commit();self.send_json({'token':token,'expires_at':exp,'user':{'id':cur.lastrowid,'name':name,'email':email,'role':'guest'}},201);return
            if u.path=='/api/auth/login':
                email=str(data.get('email','')).strip().lower();pw=str(data.get('password',''))
                user=rowdict(c.execute('SELECT * FROM users WHERE lower(email)=lower(?) AND active=1',(email,)).fetchone())
                if not user or not password_ok(pw,user['password_hash']):self.send_json({'error':'Invalid email or password'},401);return
                token,exp=issue_session(c,user['id']);c.execute('UPDATE users SET last_login_at=? WHERE id=?',(ts,user['id']));audit(c,user,'login','user',user['id']);c.commit();user.pop('password_hash',None);self.send_json({'token':token,'expires_at':exp,'user':user});return
            if u.path=='/api/auth/logout':
                auth=self.headers.get('Authorization','');token=auth.split(' ',1)[1].strip() if auth.lower().startswith('bearer ') else ''
                if token:c.execute('DELETE FROM sessions WHERE token_hash=?',(hashlib.sha256(token.encode()).hexdigest(),));c.commit()
                self.send_json({'ok':True});return
            if u.path=='/api/yachts':
                actor=self.require(c,['vendor','admin']);
                if not actor:return
                vendor_id=actor.get('vendor_id') or data.get('vendor_id')
                if not vendor_id:self.send_json({'error':'vendor_id required'},400);return
                try:private_enabled,shared_enabled=model_flags(data)
                except ValueError as e:self.send_json({'error':str(e)},400);return
                data['private_enabled']=private_enabled;data['shared_enabled']=shared_enabled
                fields=['name','type','status','private_enabled','shared_enabled','guests','cabins','crew','length_m','year_built','year_refit','description','image','private_rate','shared_rate']
                vals=[data.get(f) for f in fields];slug='-'.join(str(data.get('name','yacht')).lower().split())
                cur=c.execute('''INSERT INTO yachts(vendor_id,name,slug,type,status,private_enabled,shared_enabled,guests,cabins,crew,length_m,year_built,year_refit,description,image,private_rate,shared_rate,amenities_json,experiences_json,gallery_json,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',[vendor_id,vals[0],slug]+vals[1:]+[json.dumps(data.get('amenities',[])),json.dumps(data.get('experiences',[])),json.dumps(data.get('gallery',[])),ts])
                audit(c,actor,'create','yacht',cur.lastrowid,{'name':data.get('name')});c.commit();self.send_json({'id':cur.lastrowid},201);return
            if u.path=='/api/bookings/quote':
                try:quote=booking_selection(c,data)
                except BookingSelectionError as e:self.send_json({'error':str(e)},e.status);return
                self.send_json(public_quote(quote));return
            if u.path=='/api/bookings':
                try:selection=booking_selection(c,data,True)
                except BookingSelectionError as e:
                    c.rollback();self.send_json({'error':str(e)},e.status);return
                yacht=selection['yacht'];mode=selection['mode'];guests=selection['guests'];cabins_booked=selection['cabins_booked'];departure_id=selection['departure_id']
                start=selection['start_date'];end=selection['end_date'];nights=selection['nights'];total=selection['total_amount']
                deposit_percent=selection['deposit_percent'];deposit=selection['deposit_amount'];currency=selection['currency']
                ref='ATL-'+datetime.now(timezone.utc).strftime('%y%m%d')+'-'+secrets.token_hex(3).upper();hold_minutes=int(float(setting(c,'hold_minutes','30',True)))
                expires=(datetime.now(timezone.utc)+timedelta(minutes=hold_minutes)).isoformat()
                cur=c.execute('''INSERT INTO bookings(booking_ref,yacht_id,departure_id,mode,guest_name,email,phone,guests,cabins_booked,start_date,end_date,nights,total_amount,deposit_percent,deposit_amount,amount_paid,balance_due,currency,status,payment_status,notes,expires_at,created_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?, 'pending_operator','unpaid',?,?,?,?)''',
                    (ref,yacht['id'],departure_id,mode,data.get('guest_name'),data.get('email'),data.get('phone'),guests,cabins_booked,start,end,nights,total,deposit_percent,deposit,total,currency,data.get('notes'),expires,ts,ts))
                bid=cur.lastrowid
                c.execute('INSERT INTO availability_holds(booking_id,yacht_id,departure_id,start_date,end_date,units,cabin_units,expires_at,status,created_at) VALUES(?,?,?,?,?,?,?,?,\'active\',?)',
                          (bid,yacht['id'],departure_id,start,end,guests if mode=='shared' else 1,cabins_booked,expires,ts))
                notify(c,f'New {mode} booking request {ref} for {yacht["name"]}.','New booking request',vendor_id=yacht['vendor_id'],booking_id=bid)
                audit(c,self.actor(c),'create','booking',bid,{'ref':ref,'total':total});c.commit();self.send_json({'id':bid,'booking_ref':ref,'status':'pending_operator','total_amount':total,'deposit_percent':deposit_percent,'deposit_amount':deposit,'balance_due':total,'currency':currency,'hold_expires_at':expires},201);return
            if u.path=='/api/payments/create':
                booking_id=data.get('booking_id');b=rowdict(c.execute('SELECT * FROM bookings WHERE id=?',(booking_id,)).fetchone())
                if not b:self.send_json({'error':'Booking not found'},404);return
                if b['status'] in ('declined','cancelled','completed'):self.send_json({'error':'Booking is not payable'},409);return
                ptype=data.get('payment_type','deposit' if float(b['deposit_amount'])<float(b['total_amount']) else 'full')
                if ptype not in ('deposit','balance','full'):ptype='full'
                amount=payment_amount_for_booking(c,b,ptype)
                if amount<=0:self.send_json({'error':'No payment is currently due'},409);return
                rate=max(0,min(100,setting(c,'commission_rate','30',True)));commission=round(amount*rate/100,2);net=round(amount-commission,2)
                cur=c.execute('''INSERT INTO payments(booking_id,provider,payment_type,amount,currency,commission_rate,commission_amount,operator_net_amount,payout_status,status,created_at,updated_at)
                    VALUES(?,'bml',?,?,?,?,?,?,'pending','created',?,?)''',(booking_id,ptype,amount,b['currency'],rate,commission,net,ts,ts));pid=cur.lastrowid;c.commit()
                try:
                    result=create_bml_payment(b,pid,amount)
                    c.execute('UPDATE payments SET provider_reference=?,checkout_url=?,status=?,raw_response=?,updated_at=? WHERE id=?',(result['provider_reference'],result['checkout_url'],result['status'],json.dumps(result['raw']),now_iso(),pid));audit(c,self.actor(c),'create','payment',pid,{'amount':amount,'commission_rate':rate});c.commit()
                    self.send_json({'payment_id':pid,'checkout_url':result['checkout_url'],'provider_reference':result['provider_reference'],'status':result['status'],'gross_amount':amount,'commission_rate':rate,'commission_amount':commission,'operator_net_amount':net},201)
                except Exception as e:
                    c.execute("UPDATE payments SET status='failed',raw_response=?,updated_at=? WHERE id=?",(json.dumps({'error':str(e)}),now_iso(),pid));c.commit();self.send_json({'error':str(e),'payment_id':pid},502)
                return
            if u.path=='/api/payments/demo-complete':
                if bml_config()['mode']=='live':self.send_json({'error':'Disabled in live mode'},403);return
                status=data.get('status','paid');status=status if status in ('paid','failed','cancelled') else 'paid';p=payment_mark(c,data.get('payment_id'),status,{'mode':'mock'},self.actor(c))
                if not p:self.send_json({'error':'Payment not found'},404);return
                c.commit();self.send_json({'ok':True,'status':status});return
            if u.path.endswith('/reconcile') and u.path.startswith('/api/payments/'):
                actor=self.require(c,['vendor','admin']);
                if not actor:return
                pid=u.path.split('/')[3];p=rowdict(c.execute('SELECT * FROM payments WHERE id=?',(pid,)).fetchone())
                if not p:self.send_json({'error':'Payment not found'},404);return
                if not p.get('provider_reference'):self.send_json({'error':'Payment has no provider reference'},409);return
                body=bml_get_transaction(p['provider_reference']);status=normalized_bml_status(body);payment_mark(c,pid,status,body,actor);c.commit();self.send_json({'status':status,'provider_response':body});return
            if u.path=='/api/refunds':
                actor=self.require(c,['admin']);
                if not actor:return
                p=rowdict(c.execute('SELECT * FROM payments WHERE id=?',(data.get('payment_id'),)).fetchone())
                if not p or p['status']!='paid':self.send_json({'error':'A paid payment is required'},400);return
                refunded=float(c.execute("SELECT COALESCE(SUM(amount),0) s FROM refunds WHERE payment_id=? AND status IN ('recorded','processed')",(p['id'],)).fetchone()['s'] or 0)
                amount=round(float(data.get('amount') or 0),2)
                if amount<=0 or refunded+amount>float(p['amount'])+0.001:self.send_json({'error':'Invalid refund amount'},400);return
                ratio=amount/float(p['amount']);crev=round(float(p['commission_amount'])*ratio,2);orev=round(float(p['operator_net_amount'])*ratio,2)
                cur=c.execute('INSERT INTO refunds(payment_id,booking_id,amount,commission_reversal,operator_reversal,reason,status,created_at) VALUES(?,?,?,?,?,?,\'recorded\',?)',(p['id'],p['booking_id'],amount,crev,orev,data.get('reason'),ts));sync_booking_totals(c,p['booking_id']);audit(c,actor,'refund_recorded','refund',cur.lastrowid,{'amount':amount});c.commit();self.send_json({'id':cur.lastrowid,'amount':amount,'commission_reversal':crev,'operator_reversal':orev,'status':'recorded'},201);return
            if u.path=='/api/admin/payouts':
                actor=self.require(c,['admin']);
                if not actor:return
                vendor_id=int(data.get('vendor_id') or 0);amount=round(float(data.get('amount') or 0),2)
                if amount<=0:self.send_json({'error':'amount must be positive'},400);return
                cur=c.execute('INSERT INTO payouts(vendor_id,amount,currency,status,reference,notes,created_at) VALUES(?,?,?,\'pending\',?,?,?)',(vendor_id,amount,data.get('currency','USD'),data.get('reference'),data.get('notes'),ts));audit(c,actor,'payout_created','payout',cur.lastrowid,{'amount':amount});c.commit();self.send_json({'id':cur.lastrowid,'status':'pending'},201);return
            if u.path=='/api/enquiries':
                cur=c.execute('INSERT INTO enquiries(yacht_id,guest_name,email,guests,experience,message,status,created_at) VALUES(?,?,?,?,?,?,\'new\',?)',(data.get('yacht_id'),data.get('guest_name'),data.get('email'),data.get('guests'),data.get('experience'),data.get('message'),ts));c.commit();self.send_json({'id':cur.lastrowid},201);return
            if u.path.endswith('/departures') and u.path.startswith('/api/yachts/'):
                actor=self.require(c,['vendor','admin']);
                if not actor:return
                i=u.path.split('/')[3];y=rowdict(c.execute('SELECT * FROM yachts WHERE id=?',(i,)).fetchone())
                if not y:self.send_json({'error':'Yacht not found'},404);return
                if actor.get('role')=='vendor' and y['vendor_id']!=actor.get('vendor_id'):self.send_json({'error':'Forbidden'},403);return
                if not y['shared_enabled']:self.send_json({'error':'Yacht must have Liveaboard enabled'},400);return
                try:v=departure_values(data)
                except ValueError as e:self.send_json({'error':str(e)},400);return
                cur=c.execute('''INSERT INTO departures(yacht_id,title,start_date,end_date,nights,cabins_total,cabins_available,places_total,places_available,price_pp,status)
                                 VALUES(?,?,?,?,?,?,?,?,?,?,?)''',(i,v['title'],v['start_date'],v['end_date'],v['nights'],v['cabins_total'],v['cabins_available'],v['places_total'],v['places_available'],v['price_pp'],v['status']))
                audit(c,actor,'create','departure',cur.lastrowid,{'yacht_id':i});c.commit();self.send_json({'id':cur.lastrowid},201);return
            if u.path=='/api/vendor/documents':
                actor=self.require(c,['vendor','admin']);
                if not actor:return
                vendor_id=actor.get('vendor_id') or data.get('vendor_id');cur=c.execute('INSERT INTO vendor_documents(vendor_id,yacht_id,document_type,reference,file_url,status,note,uploaded_at) VALUES(?,?,?,?,?,\'pending\',?,?)',(vendor_id,data.get('yacht_id'),data.get('document_type'),data.get('reference'),data.get('file_url'),data.get('note'),ts));audit(c,actor,'upload_metadata','vendor_document',cur.lastrowid,{'document_type':data.get('document_type')});c.commit();self.send_json({'id':cur.lastrowid,'status':'pending'},201);return
            self.send_json({'error':'Unknown endpoint'},404)
        finally:c.close()

    def do_PUT(self):
        u=urllib.parse.urlparse(self.path);data=self.read_json();c=db_conn()
        try:
            if u.path=='/api/admin/settings':
                actor=self.require(c,['admin']);
                if not actor:return
                allowed={'commission_rate':(0,100),'deposit_percent':(0,100),'hold_minutes':(5,1440),'currency':None}
                changed={}
                for k,v in data.items():
                    if k not in allowed:continue
                    rng=allowed[k]
                    if rng:
                        try:v=float(v)
                        except:self.send_json({'error':f'{k} must be numeric'},400);return
                        if not rng[0]<=v<=rng[1]:self.send_json({'error':f'{k} out of range'},400);return
                    set_setting(c,k,v);changed[k]=v
                audit(c,actor,'settings_update','platform_settings',None,changed);c.commit();self.send_json({'ok':True,**changed});return
            if u.path.startswith('/api/admin/vendors/'):
                actor=self.require(c,['admin']);
                if not actor:return
                i=u.path.split('/')[4];verified=1 if data.get('verified') else 0;status=data.get('status') or ('verified' if verified else 'pending')
                c.execute('UPDATE vendors SET verified=?,status=?,updated_at=? WHERE id=?',(verified,status,now_iso(),i));audit(c,actor,'vendor_verification','vendor',i,{'verified':bool(verified),'status':status});c.commit();self.send_json({'ok':True});return
            if u.path.startswith('/api/admin/documents/'):
                actor=self.require(c,['admin']);
                if not actor:return
                i=u.path.split('/')[4];status=data.get('status','approved');c.execute('UPDATE vendor_documents SET status=?,note=?,reviewed_at=?,reviewed_by=? WHERE id=?',(status,data.get('note'),now_iso(),actor.get('id'),i));audit(c,actor,'document_review','vendor_document',i,{'status':status});c.commit();self.send_json({'ok':True});return
            if u.path.startswith('/api/admin/payouts/'):
                actor=self.require(c,['admin']);
                if not actor:return
                i=u.path.split('/')[4];status=data.get('status','paid');paid_at=now_iso() if status=='paid' else None;c.execute('UPDATE payouts SET status=?,reference=COALESCE(?,reference),paid_at=? WHERE id=?',(status,data.get('reference'),paid_at,i));audit(c,actor,'payout_status','payout',i,{'status':status});c.commit();self.send_json({'ok':True});return
            if u.path.startswith('/api/admin/yachts/'):
                actor=self.require(c,['admin']);
                if not actor:return
                i=u.path.split('/')[-1];c.execute('UPDATE yachts SET verified=?,verification_note=?,status=COALESCE(?,status),updated_at=? WHERE id=?',(1 if data.get('verified') else 0,data.get('verification_note'),data.get('status'),now_iso(),i));audit(c,actor,'yacht_verification','yacht',i,{'verified':bool(data.get('verified'))});c.commit();self.send_json({'ok':True});return
            if u.path.startswith('/api/departures/'):
                actor=self.require(c,['vendor','admin']);
                if not actor:return
                i=u.path.split('/')[-1]
                current=rowdict(c.execute('''SELECT d.*,y.vendor_id,y.shared_enabled FROM departures d
                                             JOIN yachts y ON y.id=d.yacht_id WHERE d.id=?''',(i,)).fetchone())
                if not current:self.send_json({'error':'Departure not found'},404);return
                if actor.get('role')=='vendor' and current['vendor_id']!=actor.get('vendor_id'):self.send_json({'error':'Forbidden'},403);return
                if not current['shared_enabled']:self.send_json({'error':'Yacht must have Liveaboard enabled'},400);return
                merged={**current,**data}
                try:v=departure_values(merged)
                except ValueError as e:self.send_json({'error':str(e)},400);return
                c.execute('''UPDATE departures SET title=?,start_date=?,end_date=?,nights=?,cabins_total=?,cabins_available=?,
                             places_total=?,places_available=?,price_pp=?,status=? WHERE id=?''',
                          (v['title'],v['start_date'],v['end_date'],v['nights'],v['cabins_total'],v['cabins_available'],v['places_total'],v['places_available'],v['price_pp'],v['status'],i))
                audit(c,actor,'update','departure',i,{'fields':list(data.keys())});c.commit();self.send_json({'ok':True});return
            if u.path.startswith('/api/yachts/'):
                actor=self.require(c,['vendor','admin']);
                if not actor:return
                i=u.path.split('/')[-1];y=rowdict(c.execute('SELECT * FROM yachts WHERE id=?',(i,)).fetchone())
                if not y:self.send_json({'error':'Not found'},404);return
                if actor.get('role')=='vendor' and actor.get('vendor_id') and y['vendor_id']!=actor['vendor_id']:self.send_json({'error':'Forbidden'},403);return
                try:private_enabled,shared_enabled=model_flags(data,y)
                except ValueError as e:self.send_json({'error':str(e)},400);return
                if 'private_enabled' in data:data['private_enabled']=private_enabled
                if 'shared_enabled' in data:data['shared_enabled']=shared_enabled
                allowed=['name','type','status','private_enabled','shared_enabled','guests','cabins','crew','length_m','year_built','year_refit','description','image','private_rate','shared_rate']
                sets=[];vals=[]
                for f in allowed:
                    if f in data:sets.append(f+'=?');vals.append(data[f])
                for f in ('amenities','experiences','gallery'):
                    if f in data:sets.append(f+'_json=?');vals.append(json.dumps(data[f]))
                if not sets:self.send_json({'ok':True});return
                sets.append('updated_at=?');vals.append(now_iso());vals.append(i);c.execute('UPDATE yachts SET '+','.join(sets)+' WHERE id=?',vals);audit(c,actor,'update','yacht',i,{'fields':[s.split('=')[0] for s in sets]});c.commit();self.send_json({'ok':True});return
            if u.path.startswith('/api/bookings/'):
                actor=self.require(c,['vendor','admin']);
                if not actor:return
                i=u.path.split('/')[-1];b=rowdict(c.execute('''SELECT b.*,y.vendor_id,y.name yacht_name FROM bookings b JOIN yachts y ON y.id=b.yacht_id WHERE b.id=?''',(i,)).fetchone())
                if not b:self.send_json({'error':'Not found'},404);return
                if actor.get('role')=='vendor' and actor.get('vendor_id') and b['vendor_id']!=actor['vendor_id']:self.send_json({'error':'Forbidden'},403);return
                status=data.get('status');allowed={'approved','declined','cancelled','confirmed','completed','awaiting_payment'}
                if status not in allowed:self.send_json({'error':'Invalid booking status'},400);return
                c.execute('UPDATE bookings SET status=?,updated_at=? WHERE id=?',(status,now_iso(),i))
                if status in ('declined','cancelled','completed'):c.execute("UPDATE availability_holds SET status='released' WHERE booking_id=?",(i,))
                elif status in ('approved','awaiting_payment'):
                    hold_minutes=int(float(setting(c,'hold_minutes','30',True)));exp=(datetime.now(timezone.utc)+timedelta(minutes=hold_minutes)).isoformat();c.execute("UPDATE availability_holds SET status='active',expires_at=? WHERE booking_id=?",(exp,i));c.execute('UPDATE bookings SET expires_at=? WHERE id=?',(exp,i))
                notify(c,f'Booking {b["booking_ref"]} is now {status}.','Booking update',booking_id=int(i),recipient=b['email'])
                audit(c,actor,'booking_status','booking',i,{'status':status});c.commit();self.send_json({'ok':True,'status':status});return
            self.send_json({'error':'Unknown endpoint'},404)
        finally:c.close()


if __name__=='__main__':
    init_db();port=int(os.environ.get('PORT',8000));print(f'MaldivesLiveaboardBooking running at http://localhost:{port} (auth enforced={ENFORCE_AUTH})');ThreadingHTTPServer(('0.0.0.0',port),Handler).serve_forever()
