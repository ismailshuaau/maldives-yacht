const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "content-security-policy": "default-src 'self'; img-src 'self' https: data:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: JSON_HEADERS });
}

function now(): string { return new Date().toISOString(); }
function bool(value: unknown): boolean { return Boolean(Number(value)); }
function round(value: number): number { return Math.round((value + Number.EPSILON) * 100) / 100; }
function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function base64Bytes(value: string): Uint8Array {
  const raw = atob(value);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
function constantEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
}
async function passwordMatches(password: string, encoded: string): Promise<boolean> {
  try {
    const parts = encoded.split("$");
    const iterations = parts.length === 3 ? Number(parts[0]) : 210_000;
    const [salt, expected] = parts.length === 3 ? parts.slice(1) : parts;
    if (!salt || !expected || !Number.isInteger(iterations) || iterations < 1 || iterations > 310_000) return false;
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const saltBytes = base64Bytes(salt);
    const saltBuffer = saltBytes.buffer.slice(saltBytes.byteOffset, saltBytes.byteOffset + saltBytes.byteLength) as ArrayBuffer;
    const actual = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltBuffer, iterations }, material, 256);
    const actualEncoded = btoa(String.fromCharCode(...new Uint8Array(actual)));
    return constantEqual(actualEncoded, expected);
  } catch { return false; }
}
async function passwordHash(password: string): Promise<string> {
  const iterations = 210_000, salt = crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, material, 256);
  return `${iterations}$${btoa(String.fromCharCode(...salt))}$${btoa(String.fromCharCode(...new Uint8Array(bits)))}`;
}

type DbRow = Record<string, unknown>;
function row(raw: DbRow | null): DbRow | null {
  if (!raw) return null;
  const item = { ...raw };
  for (const key of ["amenities_json", "experiences_json", "gallery_json", "occupancy_modes_json", "matching_departures_json", "itinerary_json", "booking_conditions_json", "conditions_snapshot_json", "detail_json", "raw_response"]) {
    if (!(key in item)) continue;
    try {
      const objectValue = ["booking_conditions_json","conditions_snapshot_json","detail_json","raw_response"].includes(key);
      const parsed = JSON.parse(String(item[key] || (objectValue ? "{}" : "[]")));
      if (key.endsWith("_json")) { item[key.slice(0, -5)] = parsed; delete item[key]; }
      else item[key] = parsed;
    } catch { /* Preserve malformed legacy data for inspection. */ }
  }
  for (const key of ["private_enabled", "shared_enabled", "private_rate_public", "private_instant_booking", "mock_generated", "verified", "active", "air_conditioning", "ensuite"]) {
    if (key in item) item[key] = bool(item[key]);
  }
  if (Array.isArray(item.experiences)) item.experiences = item.experiences.map((value) => String(value).toLowerCase() === "shared liveaboard" ? "Liveaboard" : value);
  return item;
}
function rows(result: D1Result<DbRow>): DbRow[] { return result.results.map((item) => row(item) as DbRow); }
function publicYacht(item: DbRow): DbRow {
  if (!item.private_rate_public) item.private_rate = null;
  return item;
}
function safePayment(item: DbRow): DbRow { const value = row(item) as DbRow; delete value.raw_response; delete value.access_token_hash; delete value.idempotency_key; return value; }

async function body(request: Request): Promise<DbRow> {
  const maximum = 65_536, declared = Number(request.headers.get("content-length") || 0);
  if (declared > maximum) throw new HttpError("Request body too large", 413);
  if (!request.body) throw new HttpError("A valid JSON body is required", 400);
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new HttpError("Request body too large", 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
    return parsed as DbRow;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError("A valid JSON object is required", 400);
  }
}
class HttpError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

function textField(data: DbRow, key: string, maximum: number, required = false): string {
  const value = String(data[key] ?? "").trim();
  if (required && !value) throw new HttpError(`${key} is required`);
  if (value.length > maximum) throw new HttpError(`${key} is too long`);
  return value;
}
function numberField(data: DbRow, key: string, options: { integer?: boolean; minimum?: number; maximum?: number; required?: boolean } = {}): number | null {
  if (data[key] === undefined || data[key] === null || data[key] === "") {
    if (options.required) throw new HttpError(`${key} is required`);
    return null;
  }
  const value = Number(data[key]);
  if (!Number.isFinite(value) || (options.integer && !Number.isInteger(value)) || (options.minimum != null && value < options.minimum) || (options.maximum != null && value > options.maximum)) throw new HttpError(`${key} is invalid`);
  return value;
}
function emailField(data: DbRow, key = "email"): string {
  const value = textField(data, key, 254, true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new HttpError(`${key} is invalid`);
  return value;
}
function enumField(data: DbRow, key: string, allowed: readonly string[], fallback?: string): string {
  const value = String(data[key] ?? fallback ?? "");
  if (!allowed.includes(value)) throw new HttpError(`${key} is invalid`);
  return value;
}
function urlField(data: DbRow, key: string): string | null {
  const value = textField(data, key, 2_048);
  if (!value) return null;
  try { if (new URL(value).protocol !== "https:") throw new Error(); }
  catch { throw new HttpError(`${key} must be an HTTPS URL`); }
  return value;
}
function stringList(data: DbRow, key: string, maximumItems = 50): string[] {
  if (data[key] == null) return [];
  if (!Array.isArray(data[key]) || data[key].length > maximumItems) throw new HttpError(`${key} is invalid`);
  return data[key].map((value) => {
    const item = String(value).trim();
    if (!item || item.length > 120) throw new HttpError(`${key} is invalid`);
    return item;
  });
}
function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
function requestToken(request: Request, name: string): string { return request.headers.get(name) || ""; }
async function hasToken(token: string, expectedHash: unknown): Promise<boolean> {
  return Boolean(token && expectedHash && constantEqual(await sha256(token), String(expectedHash)));
}

async function userFor(request: Request, env: Env): Promise<DbRow | null> {
  const header = request.headers.get("authorization") || "";
  const cookieToken = (request.headers.get("cookie") || "").split(";").map((item) => item.trim()).find((item) => item.startsWith("atolle_session="))?.slice("atolle_session=".length) || "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : cookieToken;
  if (!token) return null;
  const tokenHash = await sha256(token);
  return row(await env.DB.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`).bind(tokenHash, now()).first<DbRow>());
}
async function requireRole(request: Request, env: Env, roles: string[]): Promise<DbRow> {
  const actor = await userFor(request, env);
  if (actor && roles.includes(String(actor.role))) return actor;
  throw new HttpError("Authentication required", 401);
}
async function canAccessBooking(request: Request, env: Env, booking: DbRow): Promise<boolean> {
  const actor = await userFor(request, env);
  if (actor?.role === "admin" || actor?.id === booking.user_id || (actor?.role === "vendor" && actor.vendor_id === booking.vendor_id)) return true;
  return hasToken(requestToken(request, "x-booking-token"), booking.access_token_hash);
}
async function requirePaymentAccess(request: Request, env: Env, paymentId: unknown): Promise<DbRow> {
  const payment = row(await env.DB.prepare(`SELECT p.*,y.vendor_id FROM payments p JOIN bookings b ON b.id=p.booking_id
    JOIN yachts y ON y.id=b.yacht_id WHERE p.id=?`).bind(paymentId).first<DbRow>());
  if (!payment) throw new HttpError("Not found", 404);
  const actor = await userFor(request, env);
  if (actor?.role === "admin" || (actor?.role === "vendor" && actor.vendor_id === payment.vendor_id)) return payment;
  if (await hasToken(requestToken(request, "x-payment-token"), payment.access_token_hash)) return payment;
  throw new HttpError("Not found", 404);
}
async function enforceLoginRateLimit(request: Request, env: Env, email: string): Promise<string> {
  const client = request.headers.get("cf-connecting-ip") || "unknown", key = await sha256(`${client}\n${email}`);
  const windowStarted = Math.floor(Date.now() / 60_000) * 60_000;
  await env.DB.prepare(`INSERT INTO login_rate_limits(key_hash,window_started,attempts) VALUES(?,?,1)
    ON CONFLICT(key_hash) DO UPDATE SET attempts=CASE WHEN window_started=? THEN attempts+1 ELSE 1 END,window_started=?`)
    .bind(key, windowStarted, windowStarted, windowStarted).run();
  const found = await env.DB.prepare("SELECT attempts FROM login_rate_limits WHERE key_hash=?").bind(key).first<{ attempts: number }>();
  if (Number(found?.attempts || 0) > 8) throw new HttpError("Too many sign-in attempts. Try again shortly.", 429);
  return key;
}
async function newSession(env: Env): Promise<{ token: string; tokenHash: string; expires_at: string }> {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(36));
  const token = btoa(String.fromCharCode(...tokenBytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const expires = new Date(Date.now() + Number(env.SESSION_HOURS || 24) * 3_600_000).toISOString();
  return { token, tokenHash: await sha256(token), expires_at: expires };
}
async function audit(env: Env, actor: DbRow | null, action: string, type: string, id?: unknown, detail: DbRow = {}): Promise<void> {
  await env.DB.prepare(`INSERT INTO audit_logs(actor_user_id,actor_role,action,entity_type,entity_id,detail_json,created_at)
    VALUES(?,?,?,?,?,?,?)`).bind(actor?.id || null, actor?.role || "system", action, type, id == null ? null : String(id), JSON.stringify(detail), now()).run();
}
async function setting(env: Env, key: string, fallback: string): Promise<string> {
  const found = await env.DB.prepare("SELECT value FROM platform_settings WHERE key=?").bind(key).first<{ value: string }>();
  return found?.value ?? fallback;
}
async function overlap(env: Env, yachtId: unknown, start: string, end: string): Promise<boolean> {
  return Boolean(await env.DB.prepare(`SELECT 1 present FROM availability_holds WHERE yacht_id=? AND status='active'
    AND departure_id IS NULL AND expires_at>? AND start_date<? AND end_date>? LIMIT 1`).bind(yachtId, now(), end, start).first());
}
async function departure(env: Env, raw: DbRow): Promise<DbRow> {
  const item = row(raw) as DbRow;
  const reserved = await env.DB.prepare(`SELECT COALESCE(SUM(units),0) places,COALESCE(SUM(cabin_units),0) cabins
    FROM availability_holds WHERE departure_id=? AND status='active' AND expires_at>?`).bind(item.id, now()).first<DbRow>();
  item.places_remaining = Math.max(0, Number(item.places_available || 0) - Number(reserved?.places || 0));
  item.cabins_remaining = Math.max(0, Number(item.cabins_available || 0) - Number(reserved?.cabins || 0));
  item.cabin_inventory = await cabinInventoryFor(env, item.id);
  return item;
}
function joinedDeparture(raw: DbRow): DbRow {
  const item = row(raw) as DbRow;
  item.places_remaining = Math.max(0, Number(item.places_available || 0) - Number(item.reserved_places || 0));
  item.cabins_remaining = Math.max(0, Number(item.cabins_available || 0) - Number(item.reserved_cabins || 0));
  delete item.reserved_places; delete item.reserved_cabins;
  return item;
}
async function cabinInventoryFor(env: Env, departureId: unknown): Promise<DbRow[]> {
  const found = await env.DB.prepare(`SELECT i.*,c.yacht_id,c.name,c.deck,c.bed_configuration,c.description,c.image,c.gallery_json,c.window_type,c.air_conditioning,c.ensuite,c.occupancy_modes_json,c.capacity,c.sort_order,
    MAX(0,(i.cabins_available*c.capacity)-COALESCE(SUM(CASE WHEN h.status='active' AND h.expires_at>? THEN CASE WHEN hi.inventory_units>0 THEN hi.inventory_units ELSE hi.cabins*c.capacity END ELSE 0 END),0)) spaces_remaining,
    CAST(MAX(0,(i.cabins_available*c.capacity)-COALESCE(SUM(CASE WHEN h.status='active' AND h.expires_at>? THEN CASE WHEN hi.inventory_units>0 THEN hi.inventory_units ELSE hi.cabins*c.capacity END ELSE 0 END),0))/c.capacity AS INTEGER) cabins_remaining
    FROM departure_cabin_inventory i JOIN yacht_cabin_types c ON c.id=i.cabin_type_id
    LEFT JOIN availability_hold_cabin_items hi ON hi.departure_id=i.departure_id AND hi.cabin_type_id=i.cabin_type_id
    LEFT JOIN availability_holds h ON h.id=hi.hold_id
    WHERE i.departure_id=? AND c.active=1 GROUP BY i.departure_id,i.cabin_type_id ORDER BY c.sort_order,c.id`)
    .bind(now(), now(), departureId).all<DbRow>();
  return rows(found);
}
async function cabinTypesFor(env: Env, yachtId: unknown): Promise<DbRow[]> {
  return rows(await env.DB.prepare("SELECT * FROM yacht_cabin_types WHERE yacht_id=? AND active=1 ORDER BY sort_order,id").bind(yachtId).all<DbRow>());
}
async function departuresFor(env: Env, yachtId?: unknown, onlyOpen = false): Promise<DbRow[]> {
  const clauses: string[] = [], values: unknown[] = [now()];
  if (yachtId != null) { clauses.push("d.yacht_id=?"); values.push(yachtId); }
  if (onlyOpen) clauses.push("d.status='open'");
  const found = await env.DB.prepare(`SELECT d.*,
    COALESCE(SUM(CASE WHEN h.status='active' AND h.expires_at>? THEN h.units ELSE 0 END),0) reserved_places,
    COALESCE(SUM(CASE WHEN h.status='active' AND h.expires_at>? THEN h.cabin_units ELSE 0 END),0) reserved_cabins
    FROM departures d LEFT JOIN availability_holds h ON h.departure_id=d.id
    ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} GROUP BY d.id ORDER BY d.mock_generated ASC,d.start_date,d.id`)
    .bind(values[0], ...values).all<DbRow>();
  const output = found.results.map(joinedDeparture);
  await Promise.all(output.map(async (item) => { item.cabin_inventory = await cabinInventoryFor(env, item.id); }));
  return output;
}
function validDates(start: unknown, end: unknown): boolean {
  return typeof start === "string" && typeof end === "string" && validCalendarDate(start) && validCalendarDate(end) && end > start;
}
function dateNights(start: string, end: string): number { return Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000); }
function enforcePrivateNightLimits(yacht: DbRow, nights: number): void {
  const minimum = Number(yacht.private_min_nights || 0), maximum = Number(yacht.private_max_nights || 0);
  if (minimum && nights < minimum) throw new HttpError(`This yacht requires at least ${minimum} nights`, 409);
  if (maximum && nights > maximum) throw new HttpError(`This yacht allows a maximum of ${maximum} nights`, 409);
}
function privateSettings(data: DbRow, current: DbRow = {}): { ratePublic: boolean; instantBooking: boolean; minNights: number | null; maxNights: number | null; rate: number | null } {
  const ratePublic = "private_rate_public" in data ? bool(data.private_rate_public) : bool(current.private_rate_public);
  const instantBooking = "private_instant_booking" in data ? bool(data.private_instant_booking) : bool(current.private_instant_booking);
  const rate = "private_rate" in data ? numberField(data, "private_rate", { minimum: 0, maximum: 10_000_000 }) : Number(current.private_rate) || null;
  const minNights = "private_min_nights" in data ? numberField(data, "private_min_nights", { integer: true, minimum: 1, maximum: 365 }) : Number(current.private_min_nights) || null;
  const maxNights = "private_max_nights" in data ? numberField(data, "private_max_nights", { integer: true, minimum: 1, maximum: 365 }) : Number(current.private_max_nights) || null;
  if (minNights && maxNights && maxNights < minNights) throw new HttpError("private_max_nights must be greater than or equal to private_min_nights");
  if (ratePublic && (!rate || rate <= 0)) throw new HttpError("Publishing a private rate requires a positive nightly rate");
  if (instantBooking && (!ratePublic || !rate || rate <= 0)) throw new HttpError("Instant booking requires a disclosed positive private rate");
  return { ratePublic, instantBooking, minNights, maxNights, rate };
}

type BookingSelection = {
  yacht: DbRow;
  departure: DbRow | null;
  departureId: unknown;
  mode: string;
  guests: number;
  cabinsBooked: number;
  start: string;
  end: string;
  nights: number;
  total: number;
  depositPercent: number;
  deposit: number;
  balance: number;
  currency: string;
  cabinSelections: DbRow[];
};

async function bookingSelection(env: Env, data: DbRow): Promise<BookingSelection> {
  const yacht = row(await env.DB.prepare("SELECT * FROM yachts WHERE id=? AND status='live' AND verified=1").bind(data.yacht_id).first<DbRow>());
  if (!yacht) throw new HttpError("Yacht not found", 404);
  const mode = String(data.mode || ""), guests = Number(data.guests || 1);
  if (!["private", "shared"].includes(mode)) throw new HttpError("mode must be private or shared");
  if (!Number.isInteger(guests) || guests < 1) throw new HttpError("A valid guest count is required");
  let departureId: unknown = data.departure_id || null;
  let departureRow: DbRow | null = null;
  let start = String(data.start_date || ""), end = String(data.end_date || ""), nights = 0, total = 0, cabinsBooked = 0;
  let cabinSelections: DbRow[] = [];
  if (mode === "private") {
    if (!yacht.private_enabled) throw new HttpError("Private charter unavailable", 409);
    if (!yacht.private_instant_booking || !yacht.private_rate_public || Number(yacht.private_rate || 0) <= 0) throw new HttpError("This yacht accepts charter enquiries rather than instant bookings", 409);
    if (!validDates(start, end)) throw new HttpError("Valid start_date and end_date are required");
    if (start < now().slice(0, 10)) throw new HttpError("Start date cannot be in the past");
    nights = dateNights(start, end);
    enforcePrivateNightLimits(yacht, nights);
    if (guests > Number(yacht.guests)) throw new HttpError("Guest count exceeds yacht capacity");
    if (await overlap(env, yacht.id, start, end)) throw new HttpError("These dates are no longer available", 409);
    total = round(Number(yacht.private_rate || 0) * nights);
    departureId = null;
  } else {
    if (!yacht.shared_enabled) throw new HttpError("Liveaboard unavailable", 409);
    const raw = await env.DB.prepare("SELECT * FROM departures WHERE id=? AND yacht_id=? AND status='open'").bind(departureId, yacht.id).first<DbRow>();
    if (!raw) throw new HttpError("Liveaboard departure not found", 404);
    departureRow = await departure(env, raw);
    if (String(departureRow.end_date) < now().slice(0, 10)) throw new HttpError("This departure has ended", 409);
    if (!Array.isArray(data.cabin_selections) || !data.cabin_selections.length || data.cabin_selections.length > 20) throw new HttpError("Choose at least one cabin category");
    const inventory = await cabinInventoryFor(env, departureId), byId = new Map(inventory.map((item) => [String(item.cabin_type_id), item]));
    const seen = new Set<string>(); let allocatedGuests = 0;
    cabinSelections = data.cabin_selections.map((rawSelection) => {
      if (!rawSelection || typeof rawSelection !== "object" || Array.isArray(rawSelection)) throw new HttpError("cabin_selections is invalid");
      const requested = rawSelection as DbRow, typeId = String(requested.cabin_type_id || ""), item = byId.get(typeId);
      const selectedGuests = Number(requested.guests);
      if (!item || seen.has(typeId)) throw new HttpError("Cabin category is invalid");
      seen.add(typeId);
      if (!Number.isInteger(selectedGuests) || selectedGuests < 1) throw new HttpError("Allocated guests must be a positive whole number");
      const modes = Array.isArray(item.occupancy_modes) ? item.occupancy_modes.map(String) : ["private"];
      const occupancy = String(requested.occupancy_preference || (requested.cabins ? "private" : modes[0]));
      if (!["shared","private"].includes(occupancy) || !modes.includes(occupancy)) throw new HttpError(`${item.name} does not support that occupancy choice`);
      const capacity = Math.max(1,Number(item.capacity)), cabins = Math.ceil(selectedGuests/capacity);
      const inventoryUnits = occupancy === "shared" ? selectedGuests : cabins*capacity;
      if (inventoryUnits > Number(item.spaces_remaining || 0)) throw new HttpError(`${item.name} no longer has enough space`,409);
      const timestamp=now(),promoActive=(!item.promotion_starts_at||String(item.promotion_starts_at)<=timestamp)&&(!item.promotion_ends_at||String(item.promotion_ends_at)>=timestamp);
      const listPrice=Number(item.list_price_pp||item.price_pp),price=promoActive?Number(item.price_pp):listPrice,unused=Math.max(0,inventoryUnits-selectedGuests);
      const rate=occupancy==="private"&&modes.includes("shared")?Number(item.privacy_surcharge_percent||0):Number(item.single_occupancy_surcharge_percent||0);
      const surcharge=round(unused*price*rate/100),discount=round(Math.max(0,listPrice-price)*selectedGuests),lineTotal=round(selectedGuests*price+surcharge);
      allocatedGuests += selectedGuests; cabinsBooked += cabins;
      return { cabin_type_id: Number(item.cabin_type_id), cabin_type_name: item.name, cabins, guests: selectedGuests, capacity, inventory_units: inventoryUnits, occupancy_preference: occupancy, list_price_pp: listPrice, price_pp: price, discount_amount: discount, surcharge_amount: surcharge, line_total: lineTotal };
    });
    if (allocatedGuests !== guests) throw new HttpError("Allocated cabin guests must equal the total guest count");
    if (guests > Number(departureRow.places_remaining)) throw new HttpError("Not enough passenger places remain", 409);
    start = String(departureRow.start_date); end = String(departureRow.end_date); nights = Number(departureRow.nights);
    total = round(cabinSelections.reduce((sum, item) => sum + Number(item.line_total), 0));
  }
  const depositPercent = Math.max(0, Math.min(100, Number(await setting(env, "deposit_percent", "30"))));
  const deposit = round(total * depositPercent / 100), currency = await setting(env, "currency", "USD");
  return { yacht, departure: departureRow, departureId, mode, guests, cabinsBooked, start, end, nights, total, depositPercent, deposit, balance: round(total - deposit), currency, cabinSelections };
}

function quoteResponse(selection: BookingSelection): DbRow {
  return {
    yacht_id: selection.yacht.id, mode: selection.mode, departure_id: selection.departureId,
    start_date: selection.start, end_date: selection.end, nights: selection.nights,
    guests: selection.guests, cabins_booked: selection.cabinsBooked,
    cabin_selections: selection.cabinSelections,
    total: selection.total, total_amount: selection.total, deposit_percent: selection.depositPercent,
    deposit_amount: selection.deposit, balance: selection.balance, balance_amount: selection.balance, currency: selection.currency,
  };
}

type SearchParams = {
  mode: "private" | "shared";
  start: string | null;
  end: string | null;
  guests: number;
  yachtType: string;
  experience: string;
  durationMin: number;
  durationMax: number;
  priceMin: number;
  priceMax: number;
  amenities: string[];
  cursor: { rating: number; id: number } | null;
};

const AMENITY_CHOICES = ["Nitrox", "Internet", "Air-conditioned cabins", "En-suite bathrooms", "Jacuzzi", "Family cabins", "Spa", "Snorkeller-friendly"] as const;
const AMENITY_ALIASES: Record<string, string[]> = {
  "Nitrox": ["nitrox"],
  "Internet": ["internet", "wi-fi", "wifi", "wi fi"],
  "Air-conditioned cabins": ["air-conditioned cabins", "air conditioned cabins", "air conditioning", "air-conditioning", "ac cabins"],
  "En-suite bathrooms": ["en-suite bathrooms", "ensuite bathrooms", "en suite bathrooms", "en-suite bathroom", "ensuite"],
  "Jacuzzi": ["jacuzzi", "hot tub"],
  "Family cabins": ["family cabins", "family cabin"],
  "Spa": ["spa", "wellness spa"],
  "Snorkeller-friendly": ["snorkeller-friendly", "snorkeler-friendly", "snorkelling", "snorkeling", "snorkelling gear", "snorkeling gear"],
};

const SEARCH_PAGE_SIZE = 12;

function decodeSearchCursor(value: string | null): SearchParams["cursor"] {
  if (!value) return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const [rating, id]: unknown[] = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")));
    if (!Number.isFinite(rating) || !Number.isInteger(id) || Number(id) < 1) throw new Error();
    return { rating: Number(rating), id: Number(id) };
  } catch { throw new HttpError("cursor is invalid"); }
}

function encodeSearchCursor(item: DbRow): string {
  return btoa(JSON.stringify([Number(item.rating_sort || 0), Number(item.id)]))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function searchParams(url: URL): SearchParams {
  const mode = (url.searchParams.get("mode") || "").toLowerCase();
  if (mode !== "private" && mode !== "shared") throw new HttpError("mode must be private or shared");
  const start = url.searchParams.get("start"), end = url.searchParams.get("end");
  if (Boolean(start) !== Boolean(end)) throw new HttpError("start and end must be provided together");
  if (start && end && !validDates(start, end)) throw new HttpError("Valid start and end dates are required");
  const guests = Number(url.searchParams.get("guests") || 1);
  if (!Number.isInteger(guests) || guests < 1 || guests > 200) throw new HttpError("guests is invalid");
  const durationMin = Number(url.searchParams.get("duration_min") || 0);
  const durationMax = Number(url.searchParams.get("duration_max") || 0);
  if (![durationMin, durationMax].every((value) => Number.isInteger(value) && value >= 0 && value <= 365) || (durationMin && durationMax && durationMin > durationMax)) throw new HttpError("duration is invalid");
  const priceMin = Number(url.searchParams.get("price_min") || 0), priceMax = Number(url.searchParams.get("price_max") || 0);
  if (![priceMin, priceMax].every((value) => Number.isFinite(value) && value >= 0 && value <= 10_000_000) || (priceMin && priceMax && priceMin >= priceMax)) throw new HttpError("price is invalid");
  const amenities = url.searchParams.getAll("amenity");
  if (amenities.length > AMENITY_CHOICES.length || amenities.some((value) => !(AMENITY_CHOICES as readonly string[]).includes(value))) throw new HttpError("amenity is invalid");
  return {
    mode, start, end, guests,
    yachtType: (url.searchParams.get("type") || "").trim().toLowerCase(),
    experience: (url.searchParams.get("experience") || "").trim().toLowerCase(),
    durationMin, durationMax, priceMin, priceMax, amenities: [...new Set(amenities)], cursor: decodeSearchCursor(url.searchParams.get("cursor")),
  };
}

function searchQuery(params: SearchParams, timestamp: string): { sql: string; values: unknown[] } {
  const fields = `y.id,y.name,y.type,y.private_enabled,y.shared_enabled,y.guests,y.cabins,y.length_m,
    y.description,y.image,y.private_rate,y.private_rate_public,y.private_instant_booking,y.private_min_nights,y.private_max_nights,
    y.shared_rate,y.amenities_json,y.rating,y.reviews,COALESCE(y.rating,0) rating_sort`;
  const cursorSql = params.cursor ? "WHERE (rating_sort<? OR (rating_sort=? AND id<?))" : "";
  const cursorValues = params.cursor ? [params.cursor.rating, params.cursor.rating, params.cursor.id] : [];
  if (params.mode === "private") {
    const clauses = ["y.status='live'", "y.verified=1", "y.private_enabled=1", "y.guests>=?"];
    const values: unknown[] = [params.guests];
    if (params.yachtType) { clauses.push("LOWER(y.type)=?"); values.push(params.yachtType); }
    if (params.experience) { clauses.push("EXISTS (SELECT 1 FROM json_each(y.experiences_json) e WHERE LOWER(CAST(e.value AS TEXT))=?)"); values.push(params.experience); }
    if (params.priceMin || params.priceMax) {
      clauses.push("y.private_rate_public=1", "y.private_rate>0");
      if (params.priceMin) { clauses.push("y.private_rate>=?"); values.push(params.priceMin); }
      if (params.priceMax) { clauses.push("y.private_rate<?"); values.push(params.priceMax); }
    }
    for (const amenity of params.amenities) {
      const aliases = AMENITY_ALIASES[amenity];
      clauses.push(`EXISTS (SELECT 1 FROM json_each(y.amenities_json) a WHERE LOWER(TRIM(CAST(a.value AS TEXT))) IN (${aliases.map(() => "?").join(",")}))`);
      values.push(...aliases);
    }
    if (params.start && params.end) {
      clauses.push(`NOT EXISTS (SELECT 1 FROM availability_holds h
        WHERE h.yacht_id=y.id AND h.status='active' AND h.departure_id IS NULL
          AND h.expires_at>? AND h.start_date<? AND h.end_date>?)`);
      values.push(timestamp, params.end, params.start);
    }
    return {
      sql: `WITH candidate AS (SELECT ${fields} FROM yachts y WHERE ${clauses.join(" AND ")}),
        counts AS (SELECT COUNT(*) total_count FROM candidate),
        page AS (SELECT * FROM candidate ${cursorSql} ORDER BY rating_sort DESC,id DESC LIMIT ${SEARCH_PAGE_SIZE + 1})
        SELECT page.*,counts.total_count FROM counts LEFT JOIN page ON 1=1 ORDER BY page.rating_sort DESC,page.id DESC`,
      values: [...values, ...cursorValues],
    };
  }

  const departureClauses = ["d.status='open'", "d.places_available-COALESCE(h.reserved_places,0)>=?", "d.cabins_available-COALESCE(h.reserved_cabins,0)>=1"];
  const departureValues: unknown[] = [params.guests];
  if (params.start && params.end) { departureClauses.push("d.start_date<=?", "d.end_date>=?"); departureValues.push(params.end, params.start); }
  if (params.durationMin) { departureClauses.push("d.nights>=?"); departureValues.push(params.durationMin); }
  if (params.durationMax) { departureClauses.push("d.nights<=?"); departureValues.push(params.durationMax); }
  const yachtClauses = ["y.status='live'", "y.verified=1", "y.shared_enabled=1"];
  const yachtValues: unknown[] = [];
  if (params.yachtType) { yachtClauses.push("LOWER(y.type)=?"); yachtValues.push(params.yachtType); }
  if (params.experience) { yachtClauses.push("EXISTS (SELECT 1 FROM json_each(y.experiences_json) e WHERE LOWER(CAST(e.value AS TEXT))=?)"); yachtValues.push(params.experience); }
  for (const amenity of params.amenities) {
    const aliases = AMENITY_ALIASES[amenity];
    yachtClauses.push(`EXISTS (SELECT 1 FROM json_each(y.amenities_json) a WHERE LOWER(TRIM(CAST(a.value AS TEXT))) IN (${aliases.map(() => "?").join(",")}))`);
    yachtValues.push(...aliases);
  }
  if (params.priceMin) { departureClauses.push("d.price_pp>=?"); departureValues.push(params.priceMin); }
  if (params.priceMax) { departureClauses.push("d.price_pp<?"); departureValues.push(params.priceMax); }
  return {
    sql: `WITH active_holds AS (
        SELECT departure_id,SUM(units) reserved_places,SUM(cabin_units) reserved_cabins
        FROM availability_holds WHERE departure_id IS NOT NULL AND status='active' AND expires_at>?
        GROUP BY departure_id
      ), matching_departures AS (
        SELECT d.*,d.places_available-COALESCE(h.reserved_places,0) places_remaining,
          d.cabins_available-COALESCE(h.reserved_cabins,0) cabins_remaining
        FROM departures d LEFT JOIN active_holds h ON h.departure_id=d.id
        WHERE ${departureClauses.join(" AND ")}
      ), candidate AS (
        SELECT ${fields},json_group_array(json_object(
          'id',d.id,'title',d.title,'start_date',d.start_date,'end_date',d.end_date,'nights',d.nights,
          'embarkation',d.embarkation,'disembarkation',d.disembarkation,'itinerary',json(d.itinerary_json),
          'cabins_available',d.cabins_available,'places_available',d.places_available,'price_pp',d.price_pp,
          'mock_generated',d.mock_generated,'places_remaining',d.places_remaining,
          'cabins_remaining',d.cabins_remaining,'available_units',d.places_remaining
        )) matching_departures_json
        FROM yachts y JOIN matching_departures d ON d.yacht_id=y.id
        WHERE ${yachtClauses.join(" AND ")} GROUP BY y.id
      ), counts AS (SELECT COUNT(*) total_count FROM candidate),
      page AS (SELECT * FROM candidate ${cursorSql} ORDER BY rating_sort DESC,id DESC LIMIT ${SEARCH_PAGE_SIZE + 1})
      SELECT page.*,counts.total_count FROM counts LEFT JOIN page ON 1=1 ORDER BY page.rating_sort DESC,page.id DESC`,
    values: [timestamp, ...departureValues, ...yachtValues, ...cursorValues],
  };
}

function anonymousRequest(request: Request): boolean {
  return !request.headers.has("cookie") && !request.headers.has("authorization");
}

function canonicalSearchKey(url: URL): Request {
  const key = new URL(url.origin + url.pathname);
  const params = new URLSearchParams(url.searchParams);
  params.sort();
  key.search = params.toString();
  return new Request(key.toString(), { method: "GET" });
}

async function searchApi(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const started = performance.now(), params = searchParams(url), anonymous = anonymousRequest(request);
  const key = canonicalSearchKey(url);
  if (anonymous) {
    const cached = await caches.default.match(key);
    if (cached) {
      const headers = new Headers(cached.headers), duration = performance.now() - started;
      headers.set("X-Atolle-Cache", "HIT");
      headers.set("Server-Timing", `cache;desc=\"HIT\";dur=${duration.toFixed(1)}, total;dur=${duration.toFixed(1)}`);
      console.log(JSON.stringify({ event: "search", mode: params.mode, cache: "HIT", duration_ms: round(duration) }));
      return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
    }
  }

  const timestamp = now(), query = searchQuery(params, timestamp);
  const database: D1Database | D1DatabaseSession = anonymous ? env.DB.withSession("first-unconstrained") : env.DB;
  const dbStarted = performance.now();
  const result = await database.prepare(query.sql).bind(...query.values).all<DbRow>();
  const dbDuration = performance.now() - dbStarted;
  const found = result.results.filter((item) => item.id != null);
  const page = found.slice(0, SEARCH_PAGE_SIZE);
  const items = page.map((item) => {
    const parsed = publicYacht(row(item) as DbRow);
    delete parsed.total_count; delete parsed.rating_sort;
    return parsed;
  });
  const payload = {
    items,
    total: Number(result.results[0]?.total_count || 0),
    next_cursor: found.length > SEARCH_PAGE_SIZE && page.length ? encodeSearchCursor(page[page.length - 1]) : null,
  };
  const responseBody = JSON.stringify(payload), payloadBytes = new TextEncoder().encode(responseBody).byteLength;
  const duration = performance.now() - started, cacheStatus = anonymous ? "MISS" : "BYPASS";
  const headers = new Headers(JSON_HEADERS);
  headers.set("Cache-Control", anonymous ? "public, max-age=30" : "no-store");
  headers.set("X-Atolle-Cache", cacheStatus);
  headers.set("Server-Timing", `db;dur=${dbDuration.toFixed(1)}, total;dur=${duration.toFixed(1)}`);
  const response = new Response(responseBody, { status: 200, headers });
  if (anonymous) ctx.waitUntil(caches.default.put(key, response.clone()).catch((error) => {
    console.error(JSON.stringify({ event: "search_cache_put_failed", error: error instanceof Error ? error.message : String(error) }));
  }));
  console.log(JSON.stringify({
    event: "search", mode: params.mode, cache: cacheStatus, duration_ms: round(duration), db_duration_ms: round(dbDuration),
    rows_read: result.meta.rows_read, rows_written: result.meta.rows_written, served_by_region: result.meta.served_by_region || null,
    served_by_primary: result.meta.served_by_primary ?? null, payload_bytes: payloadBytes, returned: items.length, total: payload.total,
  }));
  return response;
}

async function getApi(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const path = url.pathname;
  if (path === "/api/health") {
    const health = { ok: true, time: now(), environment: env.ENVIRONMENT, auth_enforced: env.ENFORCE_AUTH === "1" };
    return json(health);
  }
  if (path === "/api/booking-config") return json({
    conditions_version:await setting(env,"booking_conditions_version","2026-09-17"),
    conditions_intro:await setting(env,"booking_conditions_intro",""),
    best_price_guarantee_enabled:(await setting(env,"best_price_guarantee_enabled","0"))==="1",
    best_price_guarantee_text:await setting(env,"best_price_guarantee_text","")
  });
  if (path === "/api/search") return searchApi(request, env, ctx, url);
  if (path === "/api/search/options") {
    const database: D1Database | D1DatabaseSession = anonymousRequest(request) ? env.DB.withSession("first-unconstrained") : env.DB;
    const result = await database.prepare("SELECT DISTINCT type FROM yachts WHERE status='live' AND verified=1 AND (private_enabled=1 OR shared_enabled=1) AND type<>'' ORDER BY type").all<{ type: string }>();
    return json({ types: result.results.map((item) => item.type), amenities: AMENITY_CHOICES });
  }
  if (path === "/api/auth/me") {
    const actor = await userFor(request, env);
    if (!actor) return json({ authenticated: false }, 401);
    delete actor.password_hash;
    return json(actor);
  }
  if (path === "/api/homepage") {
    const result = await env.DB.batch([
      env.DB.prepare("SELECT COUNT(*) n FROM yachts WHERE status='live' AND verified=1"),
      env.DB.prepare("SELECT COUNT(*) n FROM departures d JOIN yachts y ON y.id=d.yacht_id WHERE d.status='open' AND d.mock_generated=0 AND date(d.end_date)>=date('now') AND y.status='live' AND y.verified=1"),
      env.DB.prepare("SELECT COUNT(DISTINCT v.id) n FROM vendors v JOIN yachts y ON y.vendor_id=v.id WHERE v.verified=1 AND v.status='verified' AND y.status='live' AND y.verified=1"),
      env.DB.prepare("SELECT COUNT(*) n FROM bookings WHERE status IN ('confirmed','completed')"),
      env.DB.prepare("SELECT COUNT(*) n FROM reviews WHERE status='approved'")
    ]);
    const reviews = rows(await env.DB.prepare(`SELECT r.id,r.rating,r.title,r.body,r.created_at,y.id yacht_id,y.name yacht_name,
      b.start_date travel_date,b.guest_name FROM reviews r JOIN bookings b ON b.id=r.booking_id JOIN yachts y ON y.id=r.yacht_id
      WHERE r.status='approved' AND b.status='completed' ORDER BY r.moderated_at DESC,r.id DESC LIMIT 12`).all<DbRow>());
    for (const review of reviews) { review.guest_initials = String(review.guest_name || "Guest").split(/\s+/).slice(0,2).map((part)=>part[0]?.toUpperCase() || "").join("") || "G"; delete review.guest_name; }
    return json({hero:{eyebrow:await setting(env,"hero_eyebrow","Private yacht charters · liveaboards"),title:await setting(env,"hero_title","Discover the Maldives on a liveaboard"),text:await setting(env,"hero_text","Choose the whole yacht or join a scheduled liveaboard, then shape the experience around you.")},
      assurances:[],
      statistics:{live_yachts:(result[0].results[0] as DbRow).n,departures:(result[1].results[0] as DbRow).n,operators:(result[2].results[0] as DbRow).n,bookings:(result[3].results[0] as DbRow).n,verified_reviews:(result[4].results[0] as DbRow).n},
      support_profiles:rows(await env.DB.prepare("SELECT * FROM support_profiles WHERE active=1 ORDER BY sort_order,id").all<DbRow>()),
      support_always_available:(await setting(env,"support_always_available","0")) === "1",reviews,
      trust_marks:rows(await env.DB.prepare("SELECT * FROM trust_marks WHERE active=1 AND verified=1 ORDER BY sort_order,id").all<DbRow>())});
  }
  if (path === "/api/account/dashboard") {
    const actor = await requireRole(request,env,["guest","vendor","admin"]);
    const bookings=rows(await env.DB.prepare(`SELECT b.*,y.name yacht_name,y.image yacht_image,
      CASE WHEN b.status='completed' AND r.id IS NULL THEN 1 ELSE 0 END review_eligible,r.id review_id,r.status review_status
      FROM bookings b JOIN yachts y ON y.id=b.yacht_id LEFT JOIN reviews r ON r.booking_id=b.id WHERE b.user_id=? ORDER BY b.created_at DESC`).bind(actor.id).all<DbRow>());
    for(const booking of bookings){delete booking.access_token_hash;delete booking.idempotency_key;}
    const saved=rows(await env.DB.prepare("SELECT y.* FROM wishlists w JOIN yachts y ON y.id=w.yacht_id WHERE w.user_id=? ORDER BY w.created_at DESC").bind(actor.id).all<DbRow>());saved.forEach(publicYacht);
    return json({user:{id:actor.id,name:actor.name,email:actor.email,role:actor.role},bookings,saved_yachts:saved,support_requests:rows(await env.DB.prepare("SELECT * FROM support_requests WHERE user_id=? ORDER BY created_at DESC").bind(actor.id).all<DbRow>())});
  }
  if (path === "/api/account/wishlist") { const actor=await requireRole(request,env,["guest","vendor","admin"]),items=rows(await env.DB.prepare("SELECT y.* FROM wishlists w JOIN yachts y ON y.id=w.yacht_id WHERE w.user_id=? ORDER BY w.created_at DESC").bind(actor.id).all<DbRow>());items.forEach(publicYacht);return json(items); }
  if (path === "/api/account/support") { const actor=await requireRole(request,env,["guest","vendor","admin"]); return json(rows(await env.DB.prepare("SELECT * FROM support_requests WHERE user_id=? ORDER BY created_at DESC").bind(actor.id).all<DbRow>())); }
  if (["/api/admin/reviews","/api/admin/support","/api/admin/support-profiles","/api/admin/trust-marks"].includes(path)) {
    await requireRole(request,env,["admin"]); const table=({"/api/admin/reviews":"reviews","/api/admin/support":"support_requests","/api/admin/support-profiles":"support_profiles","/api/admin/trust-marks":"trust_marks"} as Record<string,string>)[path];
    return json(rows(await env.DB.prepare(`SELECT * FROM ${table} ORDER BY ${["support_profiles","trust_marks"].includes(table)?"sort_order,id":"id DESC"}`).all<DbRow>()));
  }
  if (path === "/api/yachts") {
    const clauses: string[] = [], values: unknown[] = [];
    const actor = await userFor(request, env);
    if (actor?.role === "admin") {
      for (const field of ["vendor_id", "status"]) if (url.searchParams.get(field)) { clauses.push(`${field}=?`); values.push(url.searchParams.get(field)); }
    } else if (actor?.role === "vendor") {
      clauses.push("vendor_id=?"); values.push(actor.vendor_id);
      if (url.searchParams.get("status")) { clauses.push("status=?"); values.push(url.searchParams.get("status")); }
    } else {
      clauses.push("status='live'", "verified=1");
    }
    const query = url.searchParams.get("q");
    if (query) { clauses.push("(name LIKE ? OR type LIKE ? OR description LIKE ?)"); values.push(`%${query}%`, `%${query}%`, `%${query}%`); }
    const result = await env.DB.prepare(`SELECT * FROM yachts${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY verified DESC,rating DESC,id DESC`).bind(...values).all<DbRow>();
    const yachts = rows(result);
    if (actor?.role === "admin" || actor?.role === "vendor") await Promise.all(yachts.map(async (item) => { item.cabin_types = await cabinTypesFor(env, item.id); }));
    if (!(actor?.role === "admin" || actor?.role === "vendor")) yachts.forEach(publicYacht);
    const mode = (url.searchParams.get("mode") || "").toLowerCase();
    if (!mode) return json(yachts);
    if (!["private", "shared"].includes(mode)) throw new HttpError("mode must be private or shared");
    const start = url.searchParams.get("start"), end = url.searchParams.get("end");
    if (Boolean(start) !== Boolean(end)) throw new HttpError("start and end must be provided together");
    if (start && end && !validDates(start, end)) throw new HttpError("Valid start and end dates are required");
    const guestsRaw = Number(url.searchParams.get("guests") || 1);
    if (!Number.isInteger(guestsRaw) || guestsRaw < 1 || guestsRaw > 200) throw new HttpError("guests is invalid");
    const guests = guestsRaw;
    const yachtType = (url.searchParams.get("type") || "").toLowerCase();
    const experience = (url.searchParams.get("experience") || "").toLowerCase();
    const durationMin = Number(url.searchParams.get("duration_min") || 0), durationMax = Number(url.searchParams.get("duration_max") || 0);
    if (![durationMin, durationMax].every((value) => Number.isInteger(value) && value >= 0 && value <= 365)) throw new HttpError("duration is invalid");
    const output: DbRow[] = [];
    for (const yacht of yachts) {
      if (yachtType && String(yacht.type || "").toLowerCase() !== yachtType) continue;
      if (experience && !(yacht.experiences as unknown[] || []).some((x) => String(x).toLowerCase() === experience)) continue;
      if (mode === "private") {
        if (!yacht.private_enabled || guests > Number(yacht.guests || 0)) continue;
        if (start && end && await overlap(env, yacht.id, start, end)) continue;
        output.push(yacht); continue;
      }
      if (!yacht.shared_enabled) continue;
      const depRows = await departuresFor(env, yacht.id, true);
      const matches: DbRow[] = [];
      for (const raw of depRows) {
        const dep = raw, nights = Number(dep.nights || 0);
        if (start && end && (String(dep.start_date) > end || String(dep.end_date) < start)) continue;
        if ((durationMin && nights < durationMin) || (durationMax && nights > durationMax)) continue;
        if (Number(dep.places_remaining) < guests || Number(dep.cabins_remaining) < 1) continue;
        dep.available_units = dep.places_remaining; matches.push(dep);
      }
      if (matches.length) { yacht.matching_departures = matches; output.push(yacht); }
    }
    return json(output);
  }
  const yachtMatch = path.match(/^\/api\/yachts\/(\d+)$/);
  if (yachtMatch) {
    const yacht = row(await env.DB.prepare("SELECT * FROM yachts WHERE id=?").bind(yachtMatch[1]).first<DbRow>());
    if (!yacht) throw new HttpError("Not found", 404);
    const actor = await userFor(request, env);
    if (!(yacht.status === "live" && yacht.verified) && !(actor?.role === "admin" || (actor?.role === "vendor" && actor.vendor_id === yacht.vendor_id))) throw new HttpError("Not found", 404);
    const month = url.searchParams.get("month");
    if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError("month must use YYYY-MM");
    const allDepartures = await departuresFor(env, yachtMatch[1], true);
    const availableMonths = [...new Set(allDepartures.map((item) => String(item.start_date || "").slice(0, 7)).filter((value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value)))];
    yacht.departures = month ? allDepartures.filter((item) => String(item.start_date || "").startsWith(`${month}-`)) : allDepartures;
    yacht.cabin_types = await cabinTypesFor(env, yachtMatch[1]);
    yacht.available_months = availableMonths;
    yacht.departure_meta = {
      selected_month: month || null,
      total_open: allDepartures.length,
      returned: (yacht.departures as unknown[]).length,
      next_available_month: availableMonths.find((value) => value >= now().slice(0, 7)) || availableMonths[0] || null,
    };
    if (!(actor?.role === "admin" || (actor?.role === "vendor" && actor.vendor_id === yacht.vendor_id))) publicYacht(yacht);
    return json(yacht);
  }
  const availabilityMatch = path.match(/^\/api\/yachts\/(\d+)\/availability$/);
  if (availabilityMatch) {
    const start = url.searchParams.get("start"), end = url.searchParams.get("end");
    if (!start || !end || !validDates(start, end) || start < now().slice(0, 10)) throw new HttpError("Valid future start and end dates are required");
    return json({ available: !(await overlap(env, availabilityMatch[1], start, end)) });
  }
  if (path === "/api/bookings") {
    const actor = await requireRole(request, env, ["vendor", "admin"]);
    let sql = `SELECT b.*,y.name yacht_name,y.vendor_id,d.title departure_title,d.start_date departure_start_date,d.end_date departure_end_date
      FROM bookings b JOIN yachts y ON y.id=b.yacht_id LEFT JOIN departures d ON d.id=b.departure_id`;
    const values: unknown[] = [];
    if (actor.role === "vendor") { sql += " WHERE y.vendor_id=?"; values.push(actor.vendor_id); }
    const bookings=rows(await env.DB.prepare(`${sql} ORDER BY b.id DESC`).bind(...values).all<DbRow>());
    await Promise.all(bookings.map(async booking=>{booking.travelers=rows(await env.DB.prepare("SELECT * FROM booking_guests WHERE booking_id=? ORDER BY sort_order,id").bind(booking.id).all<DbRow>());}));
    return json(bookings);
  }
  if (path === "/api/departures") {
    const actor = await requireRole(request, env, ["vendor", "admin"]);
    const clauses: string[] = [], values: unknown[] = [];
    const generated = url.searchParams.get("include_generated") || "1";
    if (!["0", "1"].includes(generated)) throw new HttpError("include_generated must be 0 or 1");
    if (generated === "0") clauses.push("d.mock_generated=0");
    if (actor.role === "vendor") { clauses.push("y.vendor_id=?"); values.push(actor.vendor_id); }
    const found = rows(await env.DB.prepare(`SELECT d.*,y.name yacht_name,y.vendor_id,
      COALESCE(SUM(CASE WHEN h.status='active' AND h.expires_at>? THEN h.units ELSE 0 END),0) reserved_places,
      COALESCE(SUM(CASE WHEN h.status='active' AND h.expires_at>? THEN h.cabin_units ELSE 0 END),0) reserved_cabins
      FROM departures d JOIN yachts y ON y.id=d.yacht_id LEFT JOIN availability_holds h ON h.departure_id=d.id${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}
      GROUP BY d.id ORDER BY d.start_date DESC,d.id DESC`).bind(now(), now(), ...values).all<DbRow>());
    const output = found.map(joinedDeparture); await Promise.all(output.map(async (item) => { item.cabin_inventory = await cabinInventoryFor(env,item.id); })); return json(output);
  }
  const bookingMatch = path.match(/^\/api\/bookings\/(\d+)$/);
  if (bookingMatch) {
    const actor = await requireRole(request, env, ["vendor", "admin"]);
    const booking = row(await env.DB.prepare("SELECT b.*,y.name yacht_name,y.vendor_id FROM bookings b JOIN yachts y ON y.id=b.yacht_id WHERE b.id=?").bind(bookingMatch[1]).first<DbRow>());
    if (!booking) throw new HttpError("Not found", 404);
    if (actor.role === "vendor" && actor.vendor_id !== booking.vendor_id) throw new HttpError("Forbidden", 403);
    booking.payments = (await env.DB.prepare("SELECT * FROM payments WHERE booking_id=? ORDER BY id").bind(bookingMatch[1]).all<DbRow>()).results.map(safePayment);
    booking.refunds = rows(await env.DB.prepare("SELECT * FROM refunds WHERE booking_id=? ORDER BY id").bind(bookingMatch[1]).all<DbRow>());
    booking.cabin_items = rows(await env.DB.prepare("SELECT * FROM booking_cabin_items WHERE booking_id=? ORDER BY id").bind(bookingMatch[1]).all<DbRow>());
    booking.travelers = rows(await env.DB.prepare("SELECT * FROM booking_guests WHERE booking_id=? ORDER BY sort_order,id").bind(bookingMatch[1]).all<DbRow>());
    return json(booking);
  }
  if (path === "/api/payments") {
    const actor = await requireRole(request, env, ["vendor", "admin"]);
    let sql = "SELECT p.*,b.guest_name,y.name yacht_name,y.vendor_id FROM payments p JOIN bookings b ON b.id=p.booking_id JOIN yachts y ON y.id=b.yacht_id";
    const values: unknown[] = [];
    if (actor.role === "vendor") { sql += " WHERE y.vendor_id=?"; values.push(actor.vendor_id); }
    return json((await env.DB.prepare(`${sql} ORDER BY p.id DESC`).bind(...values).all<DbRow>()).results.map(safePayment));
  }
  const paymentMatch = path.match(/^\/api\/payments\/(\d+)$/);
  if (paymentMatch) {
    const payment = await requirePaymentAccess(request, env, paymentMatch[1]);
    const actor = await userFor(request, env);
    if (!(actor?.role === "admin" || actor?.role === "vendor")) for (const key of ["booking_id", "commission_rate", "commission_amount", "operator_net_amount", "payout_status"]) delete payment[key];
    delete payment.raw_response; delete payment.access_token_hash; delete payment.idempotency_key; delete payment.vendor_id;
    return json(payment);
  }
  if (path === "/api/payment/config") return json({ provider: "bml", mode: env.BML_MODE, environment: env.BML_ENV, currency: env.BML_CURRENCY, live_configured: false });
  if (path === "/api/admin/settings") {
    await requireRole(request, env, ["admin"]);
    const found = await env.DB.prepare("SELECT key,value FROM platform_settings").all<{ key: string; value: string }>();
    return json(Object.fromEntries(found.results.map((item) => [item.key, item.value])));
  }
  if (path === "/api/enquiries") {
    const actor = await requireRole(request, env, ["vendor", "admin"]);
    const query = "SELECT e.*,y.name yacht_name,y.vendor_id FROM enquiries e JOIN yachts y ON y.id=e.yacht_id";
    return json(rows(actor.role === "vendor" ? await env.DB.prepare(`${query} WHERE y.vendor_id=? ORDER BY e.id DESC`).bind(actor.vendor_id).all<DbRow>() : await env.DB.prepare(`${query} ORDER BY e.id DESC`).all<DbRow>()));
  }
  if (path === "/api/admin/stats") {
    await requireRole(request, env, ["admin"]);
    const stats = await env.DB.prepare(`SELECT COUNT(*) yachts,SUM(status='live') live,SUM(private_enabled=1) private_enabled,
      SUM(shared_enabled=1) shared_enabled,SUM(verified=0) pending_verification FROM yachts`).first<DbRow>();
    const extra = await env.DB.batch([
      env.DB.prepare("SELECT COUNT(*) n FROM bookings"), env.DB.prepare("SELECT COUNT(*) n FROM enquiries"),
      env.DB.prepare("SELECT COUNT(*) n FROM vendors WHERE verified=0")
    ]);
    return json({ ...stats, bookings: (extra[0].results[0] as DbRow).n, enquiries: (extra[1].results[0] as DbRow).n, vendors_pending: (extra[2].results[0] as DbRow).n });
  }
  if (path === "/api/admin/vendors") { await requireRole(request, env, ["admin"]); return json(rows(await env.DB.prepare("SELECT * FROM vendors ORDER BY id DESC").all<DbRow>())); }
  if (path === "/api/vendor/documents") {
    const actor = await requireRole(request, env, ["vendor", "admin"]);
    return json(rows(actor.role === "vendor" ? await env.DB.prepare("SELECT * FROM vendor_documents WHERE vendor_id=? ORDER BY id DESC").bind(actor.vendor_id).all<DbRow>() : await env.DB.prepare("SELECT * FROM vendor_documents ORDER BY id DESC").all<DbRow>()));
  }
  if (path === "/api/admin/ledger") {
    await requireRole(request, env, ["admin"]);
    return json(rows(await env.DB.prepare(`SELECT v.id vendor_id,v.name,
      COALESCE(SUM(CASE WHEN p.status='paid' THEN p.operator_net_amount ELSE 0 END),0)-
      COALESCE((SELECT SUM(r.operator_reversal) FROM refunds r JOIN payments rp ON rp.id=r.payment_id JOIN bookings rb ON rb.id=rp.booking_id JOIN yachts ry ON ry.id=rb.yacht_id WHERE ry.vendor_id=v.id AND r.status IN ('recorded','processed')),0)-
      COALESCE((SELECT SUM(po.amount) FROM payouts po WHERE po.vendor_id=v.id AND po.status IN ('pending','paid')),0) available_balance
      FROM vendors v LEFT JOIN yachts y ON y.vendor_id=v.id LEFT JOIN bookings b ON b.yacht_id=y.id LEFT JOIN payments p ON p.booking_id=b.id GROUP BY v.id,v.name ORDER BY v.id`).all<DbRow>()));
  }
  if (path === "/api/admin/payouts") { await requireRole(request, env, ["admin"]); return json(rows(await env.DB.prepare("SELECT p.*,v.name vendor_name FROM payouts p JOIN vendors v ON v.id=p.vendor_id ORDER BY p.id DESC").all<DbRow>())); }
  if (path === "/api/notifications") {
    const actor = await requireRole(request, env, ["vendor", "admin"]);
    return json(rows(actor.role === "vendor" ? await env.DB.prepare("SELECT * FROM notifications WHERE vendor_id=? ORDER BY id DESC LIMIT 100").bind(actor.vendor_id).all<DbRow>() : await env.DB.prepare("SELECT * FROM notifications ORDER BY id DESC LIMIT 100").all<DbRow>()));
  }
  if (path === "/api/admin/audit") { await requireRole(request, env, ["admin"]); return json(rows(await env.DB.prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200").all<DbRow>())); }
  throw new HttpError("Unknown endpoint", 404);
}

async function syncBooking(env: Env, bookingId: unknown): Promise<void> {
  const paid = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) value FROM payments WHERE booking_id=? AND status='paid'").bind(bookingId).first<{ value: number }>();
  const refunded = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) value FROM refunds WHERE booking_id=? AND status='processed'").bind(bookingId).first<{ value: number }>();
  const booking = await env.DB.prepare("SELECT total_amount FROM bookings WHERE id=?").bind(bookingId).first<{ total_amount: number }>();
  if (!booking) return;
  const net = Math.max(0, Number(paid?.value || 0) - Number(refunded?.value || 0));
  const balance = Math.max(0, Number(booking.total_amount) - net);
  const status = booking.total_amount > 0 && balance <= 0.009 ? "paid" : net > 0 ? "partial" : "unpaid";
  await env.DB.prepare("UPDATE bookings SET amount_paid=?,balance_due=?,payment_status=?,updated_at=? WHERE id=?").bind(round(net), round(balance), status, now(), bookingId).run();
}
async function markPayment(env: Env, paymentId: unknown, status: string, actor: DbRow | null): Promise<boolean> {
  const payment = await env.DB.prepare("SELECT * FROM payments WHERE id=?").bind(paymentId).first<DbRow>();
  if (!payment) return false;
  if (payment.status === "paid" && status !== "paid") return true;
  await env.DB.batch([
    env.DB.prepare("UPDATE payments SET status=?,raw_response=?,updated_at=? WHERE id=?").bind(status, JSON.stringify({ mode: "mock" }), now(), paymentId),
    status === "paid" ? env.DB.prepare("UPDATE bookings SET status=CASE WHEN status IN ('pending_operator','approved','awaiting_payment') THEN 'confirmed' ELSE status END WHERE id=?").bind(payment.booking_id) : env.DB.prepare("SELECT 1"),
    status === "paid" ? env.DB.prepare("UPDATE availability_holds SET expires_at=?,status='active' WHERE booking_id=?").bind(new Date(Date.now() + 365 * 86_400_000).toISOString(), payment.booking_id) : env.DB.prepare("SELECT 1")
  ]);
  await syncBooking(env, payment.booking_id); await audit(env, actor, "payment_status_changed", "payment", paymentId, { status });
  return true;
}

async function postApi(request: Request, env: Env, url: URL): Promise<Response> {
  const data = await body(request), path = url.pathname, timestamp = now();
  if (path === "/api/auth/register") {
    const name=textField(data,"name",120,true),email=emailField(data),password=textField(data,"password",256,true);
    if(password.length<10)throw new HttpError("Password must be at least 10 characters");
    if(await env.DB.prepare("SELECT 1 FROM users WHERE lower(email)=lower(?)").bind(email).first())throw new HttpError("Email already registered",409);
    const insert=await env.DB.prepare("INSERT INTO users(name,email,password_hash,role,active,created_at) VALUES(?,?,?,'guest',1,?)").bind(name,email,await passwordHash(password),timestamp).run();
    const session=await newSession(env);await env.DB.batch([
      env.DB.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)").bind(session.tokenHash,insert.meta.last_row_id,session.expires_at,timestamp),
      env.DB.prepare("INSERT INTO audit_logs(actor_user_id,actor_role,action,entity_type,entity_id,detail_json,created_at) VALUES(?,'guest','register','user',?,'{}',?)").bind(insert.meta.last_row_id,String(insert.meta.last_row_id),timestamp)
    ]);
    return Response.json({expires_at:session.expires_at,user:{id:insert.meta.last_row_id,name,email,role:"guest"}},{status:201,headers:{...JSON_HEADERS,"set-cookie":`atolle_session=${session.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(1,Math.floor((Date.parse(session.expires_at)-Date.now())/1000))}`}});
  }
  if (path === "/api/auth/login") {
    const email = emailField(data), password = textField(data, "password", 256, true);
    const rateLimitKey = await enforceLoginRateLimit(request, env, email);
    const found = row(await env.DB.prepare("SELECT * FROM users WHERE lower(email)=lower(?) AND active=1").bind(email).first<DbRow>());
    const matches = await passwordMatches(password, String(found?.password_hash || "100000$pT7jaBpdCzOUZE210qbCAg==$aq5erft4qjlvrmhF/6ZhWsD+VJQ9VEOacr752DVlPE8="));
    if (!found || !matches) throw new HttpError("Invalid email or password", 401);
    const session = await newSession(env);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)").bind(session.tokenHash, found.id, session.expires_at, timestamp),
      env.DB.prepare("UPDATE users SET last_login_at=? WHERE id=?").bind(timestamp, found.id),
      env.DB.prepare("DELETE FROM sessions WHERE expires_at<=?").bind(timestamp),
      env.DB.prepare("DELETE FROM login_rate_limits WHERE key_hash=?").bind(rateLimitKey),
      env.DB.prepare("DELETE FROM login_rate_limits WHERE window_started<?").bind(Date.now() - 3_600_000),
      env.DB.prepare("INSERT INTO audit_logs(actor_user_id,actor_role,action,entity_type,entity_id,detail_json,created_at) VALUES(?,?,?,?,?,?,?)").bind(found.id, found.role, "login", "user", String(found.id), "{}", timestamp)
    ]);
    delete found.password_hash;
    return Response.json({ expires_at: session.expires_at, user: found }, { headers: { ...JSON_HEADERS, "set-cookie": `atolle_session=${session.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(1, Math.floor((Date.parse(session.expires_at) - Date.now()) / 1000))}` } });
  }
  if (path === "/api/auth/logout") {
    const header = request.headers.get("authorization") || "";
    const cookieToken = (request.headers.get("cookie") || "").split(";").map((item) => item.trim()).find((item) => item.startsWith("atolle_session="))?.slice("atolle_session=".length) || "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : cookieToken;
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run();
    return Response.json({ ok: true }, { headers: { ...JSON_HEADERS, "set-cookie": "atolle_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0" } });
  }
  if (path === "/api/account/wishlist") {
    const actor=await requireRole(request,env,["guest","vendor","admin"]),yachtId=numberField(data,"yacht_id",{integer:true,minimum:1,required:true});
    if(!await env.DB.prepare("SELECT 1 FROM yachts WHERE id=? AND status='live' AND verified=1").bind(yachtId).first())throw new HttpError("Yacht not found",404);
    await env.DB.prepare("INSERT OR IGNORE INTO wishlists(user_id,yacht_id,created_at) VALUES(?,?,?)").bind(actor.id,yachtId,timestamp).run();await audit(env,actor,"save","yacht",yachtId);return json({ok:true,yacht_id:yachtId},201);
  }
  if (path === "/api/account/bookings/claim") {
    const actor=await requireRole(request,env,["guest","vendor","admin"]),ref=textField(data,"booking_ref",80,true).toUpperCase(),token=textField(data,"booking_token",256,true);
    const booking=row(await env.DB.prepare("SELECT * FROM bookings WHERE booking_ref=?").bind(ref).first<DbRow>());
    if(!booking||!await hasToken(token,booking.access_token_hash))throw new HttpError("Booking reference or access token is invalid",403);
    if(booking.user_id&&booking.user_id!==actor.id)throw new HttpError("Booking is already attached to another account",409);
    await env.DB.prepare("UPDATE bookings SET user_id=?,updated_at=? WHERE id=?").bind(actor.id,timestamp,booking.id).run();await audit(env,actor,"claim","booking",booking.id);return json({ok:true,booking_id:booking.id});
  }
  if (path === "/api/account/reviews") {
    const actor=await requireRole(request,env,["guest","vendor","admin"]),bookingId=numberField(data,"booking_id",{integer:true,minimum:1,required:true}),rating=numberField(data,"rating",{integer:true,minimum:1,maximum:5,required:true}),title=textField(data,"title",120),reviewBody=textField(data,"body",4000,true);
    if(reviewBody.length<20)throw new HttpError("Review must be at least 20 characters");
    const booking=row(await env.DB.prepare("SELECT * FROM bookings WHERE id=? AND user_id=? AND status='completed'").bind(bookingId,actor.id).first<DbRow>());if(!booking)throw new HttpError("Only your completed bookings can be reviewed",403);
    if(await env.DB.prepare("SELECT 1 FROM reviews WHERE booking_id=?").bind(bookingId).first())throw new HttpError("This booking has already been reviewed",409);
    const insert=await env.DB.prepare("INSERT INTO reviews(booking_id,user_id,yacht_id,rating,title,body,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',?,?)").bind(bookingId,actor.id,booking.yacht_id,rating,title||null,reviewBody,timestamp,timestamp).run();await audit(env,actor,"submit","review",insert.meta.last_row_id);return json({id:insert.meta.last_row_id,status:"pending"},201);
  }
  if (path === "/api/support") {
    const actor=await userFor(request,env),merged={...data,name:data.name||actor?.name,email:data.email||actor?.email},name=textField(merged,"name",120,true),email=emailField(merged),subject=textField(data,"subject",160,true),message=textField(data,"message",5000,true),phone=textField(data,"phone",40)||null;
    if(subject.length<3||message.length<10)throw new HttpError("Subject and message are too short");
    const insert=await env.DB.prepare("INSERT INTO support_requests(user_id,name,email,phone,subject,message,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'new',?,?)").bind(actor?.id||null,name,email,phone,subject,message,timestamp,timestamp).run();await audit(env,actor,"create","support_request",insert.meta.last_row_id);return json({id:insert.meta.last_row_id,status:"new"},201);
  }
  if (["/api/admin/support-profiles","/api/admin/trust-marks"].includes(path)) {
    const actor=await requireRole(request,env,["admin"]),name=textField(data,"name",120,true);let insert;
    if(path.endsWith("support-profiles"))insert=await env.DB.prepare("INSERT INTO support_profiles(name,title,bio,image_url,email,phone,active,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(name,textField(data,"title",120,true),textField(data,"bio",1000)||null,urlField(data,"image_url"),textField(data,"email",254)||null,textField(data,"phone",40)||null,Number(data.active===undefined?true:bool(data.active)),numberField(data,"sort_order",{integer:true,minimum:0,maximum:10000})||0,timestamp,timestamp).run();
    else insert=await env.DB.prepare("INSERT INTO trust_marks(name,attribution,image_url,link_url,verified,active,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(name,textField(data,"attribution",500,true),urlField(data,"image_url"),urlField(data,"link_url"),Number(bool(data.verified)),Number(data.active===undefined?true:bool(data.active)),numberField(data,"sort_order",{integer:true,minimum:0,maximum:10000})||0,timestamp,timestamp).run();
    await audit(env,actor,"create",path.split("/").at(-1)||"managed_homepage",insert.meta.last_row_id);return json({id:insert.meta.last_row_id},201);
  }
  if (path === "/api/bookings/quote") return json(quoteResponse(await bookingSelection(env, data)));
  if (path === "/api/bookings") {
    const idempotencyToken = requestToken(request, "idempotency-key");
    if (idempotencyToken.length < 16 || idempotencyToken.length > 128) throw new HttpError("A valid Idempotency-Key header is required");
    const idempotencyKey = await sha256(idempotencyToken);
    const prior = row(await env.DB.prepare("SELECT * FROM bookings WHERE idempotency_key=?").bind(idempotencyKey).first<DbRow>());
    if (prior) return json({ id: prior.id, booking_ref: prior.booking_ref, status: prior.status, total_amount: prior.total_amount, deposit_percent: prior.deposit_percent, deposit_amount: prior.deposit_amount, balance_due: prior.balance_due, currency: prior.currency, hold_expires_at: prior.expires_at, booking_token: idempotencyToken }, 200);
    const selection = await bookingSelection(env, data);
    const conditionsVersion=await setting(env,"booking_conditions_version","2026-09-17");
    if(!bool(data.conditions_accepted)||String(data.conditions_version||"")!==conditionsVersion)throw new HttpError("Please review and accept the current booking conditions",409);
    const { yacht, departureId, mode, guests, cabinsBooked, start, end, nights, total, depositPercent, deposit, currency, cabinSelections } = selection;
    const guestName = textField(data, "guest_name", 120, true), email = emailField(data);
    const phone = textField(data, "phone", 40) || null, notes = textField(data, "notes", 2_000) || null;
    const refBytes = crypto.getRandomValues(new Uint8Array(8));
    const ref = `ATL-${timestamp.slice(2, 10).replaceAll("-", "")}-${hex(refBytes.buffer).toUpperCase()}`;
    const expires = new Date(Date.now() + Number(await setting(env, "hold_minutes", "30")) * 60_000).toISOString();
    const actor = await userFor(request, env);
    try {
      const statements = [
        env.DB.prepare(`INSERT INTO bookings(booking_ref,yacht_id,departure_id,mode,guest_name,email,phone,guests,cabins_booked,start_date,end_date,nights,total_amount,deposit_percent,deposit_amount,amount_paid,balance_due,currency,status,payment_status,notes,expires_at,created_at,updated_at,access_token_hash,idempotency_key,user_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?, 'pending_operator','unpaid',?,?,?, ?,?,?,?)`).bind(ref, yacht.id, departureId, mode, guestName, email, phone, guests, cabinsBooked, start, end, nights, total, depositPercent, deposit, total, currency, notes, expires, timestamp, timestamp, idempotencyKey, idempotencyKey,actor?.id||null),
        env.DB.prepare("INSERT INTO availability_holds(booking_id,yacht_id,departure_id,start_date,end_date,units,cabin_units,expires_at,status,created_at) SELECT id,?,?,?,?,?,?,?,'active',? FROM bookings WHERE booking_ref=?").bind(yacht.id, departureId, start, end, mode === "shared" ? guests : 1, cabinsBooked, expires, timestamp, ref),
        env.DB.prepare("INSERT INTO notifications(vendor_id,booking_id,channel,subject,body,status,created_at,sent_at) SELECT ?,id,'in_app','New booking request',?,'sent',?,? FROM bookings WHERE booking_ref=?").bind(yacht.vendor_id, `New ${mode} booking request ${ref} for ${yacht.name}.`, timestamp, timestamp, ref),
        env.DB.prepare("UPDATE bookings SET conditions_version=?,conditions_snapshot_json=?,conditions_accepted_at=? WHERE booking_ref=?").bind(conditionsVersion,JSON.stringify({version:conditionsVersion,platform:await setting(env,"booking_conditions_intro",""),departure:selection.departure?.booking_conditions||{}}),timestamp,ref),
        env.DB.prepare("INSERT INTO audit_logs(actor_user_id,actor_role,action,entity_type,entity_id,detail_json,created_at) SELECT ?,?,'create','booking',CAST(id AS TEXT),?,? FROM bookings WHERE booking_ref=?").bind(actor?.id || null, actor?.role || "guest", JSON.stringify({ ref, total }), timestamp, ref)
      ];
      for (const item of cabinSelections) {
        statements.push(env.DB.prepare(`INSERT INTO booking_cabin_items(booking_id,cabin_type_id,cabin_type_name,cabins,guests,capacity,price_pp,list_price_pp,occupancy_preference,discount_amount,surcharge_amount,inventory_units,line_total)
          SELECT id,?,?,?,?,?,?,?,?,?,?,?,? FROM bookings WHERE booking_ref=?`).bind(item.cabin_type_id,item.cabin_type_name,item.cabins,item.guests,item.capacity,item.price_pp,item.list_price_pp,item.occupancy_preference,item.discount_amount,item.surcharge_amount,item.inventory_units,item.line_total,ref));
        statements.push(env.DB.prepare(`INSERT INTO availability_hold_cabin_items(hold_id,departure_id,cabin_type_id,cabins,inventory_units)
          SELECT h.id,?,?,?,? FROM availability_holds h JOIN bookings b ON b.id=h.booking_id WHERE b.booking_ref=?`).bind(departureId,item.cabin_type_id,item.cabins,item.inventory_units,ref));
      }
      if(Array.isArray(data.travelers))for(const [index,rawTraveler] of data.travelers.slice(0,guests).entries()){if(!rawTraveler||typeof rawTraveler!=="object"||Array.isArray(rawTraveler))continue;const traveler=rawTraveler as DbRow;statements.push(env.DB.prepare("INSERT INTO booking_guests(booking_id,full_name,rooming_preference,notes,sort_order) SELECT id,?,?,?,? FROM bookings WHERE booking_ref=?").bind(textField(traveler,"full_name",120)||null,textField(traveler,"rooming_preference",80)||null,textField(traveler,"notes",500)||null,index,ref));}
      await env.DB.batch(statements);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/inventory unavailable|UNIQUE constraint/i.test(message)) throw new HttpError("This inventory was just reserved by another guest", 409);
      throw error;
    }
    const created = await env.DB.prepare("SELECT id FROM bookings WHERE booking_ref=?").bind(ref).first<{ id: number }>();
    const bookingId = created?.id;
    return json({ id: bookingId, booking_ref: ref, status: "pending_operator", total_amount: total, deposit_percent: depositPercent, deposit_amount: deposit, balance_due: total, currency, hold_expires_at: expires, booking_token: idempotencyToken }, 201);
  }
  if (path === "/api/payments/create") {
    const idempotencyToken = requestToken(request, "idempotency-key");
    if (idempotencyToken.length < 16 || idempotencyToken.length > 128) throw new HttpError("A valid Idempotency-Key header is required");
    const idempotencyKey = await sha256(idempotencyToken);
    const existing = row(await env.DB.prepare("SELECT * FROM payments WHERE idempotency_key=?").bind(idempotencyKey).first<DbRow>());
    if (existing) return json({ payment_id: existing.id, checkout_url: `${existing.checkout_url}&payment_id=${existing.id}&payment_token=${encodeURIComponent(idempotencyToken)}`, provider_reference: existing.provider_reference, status: existing.status, gross_amount: existing.amount }, 200);
    const booking = row(await env.DB.prepare("SELECT b.*,y.vendor_id,y.private_rate_public,y.private_instant_booking FROM bookings b JOIN yachts y ON y.id=b.yacht_id WHERE b.id=?").bind(data.booking_id).first<DbRow>());
    if (!booking) throw new HttpError("Booking not found", 404);
    if (!(await canAccessBooking(request, env, booking))) throw new HttpError("Booking not found", 404);
    if (Number(booking.total_amount || 0) <= 0) throw new HttpError("A zero-value booking cannot be paid", 409);
    if (booking.mode === "private" && (!booking.private_rate_public || !booking.private_instant_booking)) throw new HttpError("This private charter is enquiry-only", 409);
    if (["declined", "cancelled", "completed"].includes(String(booking.status))) throw new HttpError("Booking is not payable", 409);
    if (booking.status !== "confirmed" && String(booking.expires_at || "") <= timestamp) throw new HttpError("The availability hold has expired", 409);
    await syncBooking(env, booking.id);
    const current = row(await env.DB.prepare("SELECT * FROM bookings WHERE id=?").bind(booking.id).first<DbRow>()) as DbRow;
    const type = enumField(data, "payment_type", ["deposit", "balance", "full"], Number(current.deposit_amount) < Number(current.total_amount) ? "deposit" : "full");
    const amount = type === "deposit" ? round(Math.max(0, Number(current.deposit_amount) - Number(current.amount_paid))) : round(Number(current.balance_due));
    if (amount <= 0) throw new HttpError("No payment is currently due", 409);
    const rate = Math.max(0, Math.min(100, Number(await setting(env, "commission_rate", "30")))), commission = round(amount * rate / 100), net = round(amount - commission);
    const providerRef = `BML-DEMO-${hex(crypto.getRandomValues(new Uint8Array(10)).buffer).toUpperCase()}`;
    const checkoutBase = `/payment-return.html?demo=1`, actor = await userFor(request, env);
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO payments(booking_id,provider,payment_type,amount,currency,commission_rate,commission_amount,operator_net_amount,payout_status,status,provider_reference,checkout_url,raw_response,created_at,updated_at,access_token_hash,idempotency_key)
          VALUES(?,'bml',?,?,?,?,?,?,'pending','pending',?,?,?, ?,?,?,?)`).bind(booking.id, type, amount, booking.currency, rate, commission, net, providerRef, checkoutBase, JSON.stringify({ mode: "mock", reference: providerRef }), timestamp, timestamp, idempotencyKey, idempotencyKey),
        env.DB.prepare("INSERT INTO audit_logs(actor_user_id,actor_role,action,entity_type,entity_id,detail_json,created_at) VALUES(?,?,'create','payment',NULL,?,?)").bind(actor?.id || null, actor?.role || "guest", JSON.stringify({ amount, commission_rate: rate, provider_reference: providerRef }), timestamp)
      ]);
    } catch (error) {
      if (/UNIQUE constraint/i.test(error instanceof Error ? error.message : String(error))) throw new HttpError("A payment is already pending for this booking", 409);
      throw error;
    }
    const created = await env.DB.prepare("SELECT id FROM payments WHERE idempotency_key=?").bind(idempotencyKey).first<{ id: number }>();
    const paymentId = created?.id, checkout = `${checkoutBase}&payment_id=${paymentId}&payment_token=${encodeURIComponent(idempotencyToken)}`;
    return json({ payment_id: paymentId, checkout_url: checkout, provider_reference: providerRef, status: "pending", gross_amount: amount }, 201);
  }
  if (path === "/api/payments/demo-complete") {
    if (env.BML_MODE !== "mock") throw new HttpError("Demo completion is disabled", 403);
    const payment = await requirePaymentAccess(request, env, data.payment_id);
    const status = ["paid", "failed", "cancelled"].includes(String(data.status)) ? String(data.status) : "paid";
    if (!(await markPayment(env, data.payment_id, status, await userFor(request, env)))) throw new HttpError("Payment not found", 404);
    const current = await env.DB.prepare("SELECT status FROM payments WHERE id=?").bind(payment.id).first<{ status: string }>();
    return json({ ok: true, status: current?.status });
  }
  if (path === "/api/enquiries") {
    const yachtId = numberField(data, "yacht_id", { integer: true, minimum: 1, required: true });
    const yacht = row(await env.DB.prepare("SELECT * FROM yachts WHERE id=? AND status='live' AND verified=1 AND private_enabled=1").bind(yachtId).first<DbRow>());
    if (!yacht) throw new HttpError("Yacht not found", 404);
    const guestName = textField(data, "guest_name", 120, true), email = emailField(data);
    const guests = numberField(data, "guests", { integer: true, minimum: 1, maximum: 200, required: true }) as number;
    const experience = textField(data, "experience", 120) || null, message = textField(data, "message", 2_000) || null;
    const start = textField(data, "start_date", 10, true), end = textField(data, "end_date", 10, true);
    if (!validDates(start, end) || start < now().slice(0, 10)) throw new HttpError("Valid future start_date and end_date are required");
    enforcePrivateNightLimits(yacht, dateNights(start, end));
    if (guests > Number(yacht.guests || 0)) throw new HttpError("Guest count exceeds yacht capacity");
    const insert = await env.DB.prepare("INSERT INTO enquiries(yacht_id,guest_name,email,guests,experience,message,start_date,end_date,status,created_at) VALUES(?,?,?,?,?,?,?,?, 'new',?)").bind(yachtId, guestName, email, guests, experience, message, start, end, timestamp).run();
    return json({ id: insert.meta.last_row_id }, 201);
  }
  if (path === "/api/yachts") {
    const actor = await requireRole(request, env, ["vendor", "admin"]), vendorId = actor.vendor_id || data.vendor_id;
    if (!vendorId) throw new HttpError("vendor_id required");
    const privateEnabled = bool(data.private_enabled), sharedEnabled = bool(data.shared_enabled);
    if (!privateEnabled && !sharedEnabled) throw new HttpError("At least one booking model must be enabled");
    const name = textField(data, "name", 120, true), type = textField(data, "type", 80, true);
    const requestedStatus = enumField(data, "status", ["draft", "live"], "draft"), status = actor.role === "vendor" ? "draft" : requestedStatus;
    const guests = numberField(data, "guests", { integer: true, minimum: 1, maximum: 200, required: true });
    const cabins = numberField(data, "cabins", { integer: true, minimum: 1, maximum: 100, required: true });
    const crew = numberField(data, "crew", { integer: true, minimum: 0, maximum: 100 }) ?? 0;
    const length = numberField(data, "length_m", { minimum: 0, maximum: 300 }) ?? 0;
    const privateOptions = privateSettings(data);
    const privateRate = privateOptions.rate;
    const sharedRate = numberField(data, "shared_rate", { minimum: 0, maximum: 1_000_000 });
    const description = textField(data, "description", 10_000) || null, image = urlField(data, "image");
    const amenities = stringList(data, "amenities"), experiences = stringList(data, "experiences");
    const gallery = stringList(data, "gallery", 100); for (const value of gallery) { try { if (new URL(value).protocol !== "https:") throw new Error(); } catch { throw new HttpError("gallery must contain HTTPS URLs"); } }
    const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const insert = await env.DB.prepare(`INSERT INTO yachts(vendor_id,name,slug,type,status,private_enabled,shared_enabled,guests,cabins,crew,length_m,year_built,year_refit,description,image,private_rate,private_rate_public,private_instant_booking,private_min_nights,private_max_nights,shared_rate,amenities_json,experiences_json,gallery_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(vendorId, name, slug, type, status, Number(privateEnabled), Number(sharedEnabled), guests, cabins, crew, length, numberField(data, "year_built", { integer: true, minimum: 1800, maximum: 2200 }), numberField(data, "year_refit", { integer: true, minimum: 1800, maximum: 2200 }), description, image, privateRate, Number(privateOptions.ratePublic), Number(privateOptions.instantBooking), privateOptions.minNights, privateOptions.maxNights, sharedRate, JSON.stringify(amenities), JSON.stringify(experiences), JSON.stringify(gallery), timestamp).run();
    await audit(env, actor, "create", "yacht", insert.meta.last_row_id, { name }); return json({ id: insert.meta.last_row_id }, 201);
  }
  const newDeparture = path.match(/^\/api\/yachts\/(\d+)\/departures$/);
  if (newDeparture) {
    const actor = await requireRole(request, env, ["vendor", "admin"]), yacht = row(await env.DB.prepare("SELECT * FROM yachts WHERE id=?").bind(newDeparture[1]).first<DbRow>());
    if (!yacht) throw new HttpError("Yacht not found", 404);
    if (actor.role === "vendor" && yacht.vendor_id !== actor.vendor_id) throw new HttpError("Forbidden", 403);
    if (!yacht.shared_enabled) throw new HttpError("Yacht must have Liveaboard enabled");
    validateDeparture(data);
    const itinerary = itineraryField(data.itinerary), embarkation = textField(data, "embarkation", 160) || null, disembarkation = textField(data, "disembarkation", 160) || null, bookingConditions=data.booking_conditions&&typeof data.booking_conditions==="object"&&!Array.isArray(data.booking_conditions)?data.booking_conditions:{};
    const insert = await env.DB.prepare("INSERT INTO departures(yacht_id,title,start_date,end_date,nights,cabins_total,cabins_available,places_total,places_available,price_pp,status,mock_generated,embarkation,disembarkation,itinerary_json,booking_conditions_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)").bind(newDeparture[1], data.title, data.start_date, data.end_date, data.nights, data.cabins_total, data.cabins_available, data.places_total, data.places_available, data.price_pp, data.status || "open", embarkation, disembarkation, JSON.stringify(itinerary),JSON.stringify(bookingConditions)).run();
    if (Array.isArray(data.cabin_inventory)) {
      const statements: D1PreparedStatement[] = [];
      for (const rawItem of data.cabin_inventory) { const item = rawItem as DbRow, typeId = numberField(item, "cabin_type_id", { integer: true, minimum: 1, required: true }), total = numberField(item, "cabins_total", { integer: true, minimum: 0, required: true }), available = numberField(item, "cabins_available", { integer: true, minimum: 0, required: true }), price = numberField(item, "price_pp", { minimum: 0, required: true }),list=numberField(item,"list_price_pp",{minimum:0})??price,low=numberField(item,"low_stock_threshold",{integer:true,minimum:0})??4,single=numberField(item,"single_occupancy_surcharge_percent",{minimum:0,maximum:500})??0,privacy=numberField(item,"privacy_surcharge_percent",{minimum:0,maximum:500})??0; if (Number(available)>Number(total)) throw new HttpError("Cabin category availability cannot exceed its total"); statements.push(env.DB.prepare("INSERT INTO departure_cabin_inventory(departure_id,cabin_type_id,cabins_total,cabins_available,price_pp,list_price_pp,promotion_label,promotion_starts_at,promotion_ends_at,low_stock_threshold,single_occupancy_surcharge_percent,privacy_surcharge_percent) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM yacht_cabin_types WHERE id=? AND yacht_id=?)").bind(insert.meta.last_row_id,typeId,total,available,price,list,textField(item,"promotion_label",80)||null,textField(item,"promotion_starts_at",40)||null,textField(item,"promotion_ends_at",40)||null,low,single,privacy,typeId,newDeparture[1])); }
      if (statements.length) await env.DB.batch(statements);
    }
    await audit(env, actor, "create", "departure", insert.meta.last_row_id, { yacht_id: newDeparture[1] }); return json({ id: insert.meta.last_row_id }, 201);
  }
  const newCabinType = path.match(/^\/api\/yachts\/(\d+)\/cabin-types$/);
  if (newCabinType) {
    const actor = await requireRole(request, env, ["vendor", "admin"]), yacht = row(await env.DB.prepare("SELECT vendor_id FROM yachts WHERE id=?").bind(newCabinType[1]).first<DbRow>());
    if (!yacht || (actor.role === "vendor" && yacht.vendor_id !== actor.vendor_id)) throw new HttpError("Yacht not found", 404);
    const name = textField(data,"name",120,true), capacity = numberField(data,"capacity",{integer:true,minimum:1,maximum:20,required:true});
    const gallery=stringList(data,"gallery",30),modes=Array.isArray(data.occupancy_modes)?data.occupancy_modes.map(String).filter(x=>["shared","private"].includes(x)):[];
    const insert = await env.DB.prepare("INSERT INTO yacht_cabin_types(yacht_id,name,deck,bed_configuration,description,image,gallery_json,window_type,air_conditioning,ensuite,occupancy_modes_json,capacity,sort_order,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)").bind(newCabinType[1],name,textField(data,"deck",80)||null,textField(data,"bed_configuration",120)||null,textField(data,"description",1000)||null,urlField(data,"image"),JSON.stringify(gallery),textField(data,"window_type",80)||null,Number(bool(data.air_conditioning)),Number(bool(data.ensuite)),JSON.stringify(modes.length?modes:["private"]),capacity,numberField(data,"sort_order",{integer:true,minimum:0,maximum:1000})||0,timestamp,timestamp).run();
    await audit(env,actor,"create","cabin_type",insert.meta.last_row_id,{yacht_id:newCabinType[1]});return json({id:insert.meta.last_row_id},201);
  }
  if (path === "/api/vendor/documents") {
    const actor = await requireRole(request, env, ["vendor", "admin"]), vendorId = actor.vendor_id || data.vendor_id;
    const yachtId = numberField(data, "yacht_id", { integer: true, minimum: 1 });
    if (yachtId) {
      const yacht = await env.DB.prepare("SELECT vendor_id FROM yachts WHERE id=?").bind(yachtId).first<{ vendor_id: number }>();
      if (!yacht || (actor.role === "vendor" && yacht.vendor_id !== actor.vendor_id)) throw new HttpError("Yacht not found", 404);
    }
    const documentType = enumField(data, "document_type", ["Company registration", "Vessel licence", "Insurance", "Safety certificate"]);
    const reference = textField(data, "reference", 160) || null, fileUrl = urlField(data, "file_url"), note = textField(data, "note", 1_000) || null;
    if (!reference && !fileUrl) throw new HttpError("A reference or file URL is required");
    const insert = await env.DB.prepare("INSERT INTO vendor_documents(vendor_id,yacht_id,document_type,reference,file_url,status,note,uploaded_at) VALUES(?,?,?,?,?,'pending',?,?)").bind(vendorId, yachtId, documentType, reference, fileUrl, note, timestamp).run();
    await audit(env, actor, "upload_metadata", "vendor_document", insert.meta.last_row_id, { document_type: documentType }); return json({ id: insert.meta.last_row_id, status: "pending" }, 201);
  }
  const reconcileMatch = path.match(/^\/api\/payments\/(\d+)\/reconcile$/);
  if (reconcileMatch) {
    const actor = await requireRole(request, env, ["vendor", "admin"]);
    const payment = row(await env.DB.prepare("SELECT p.*,y.vendor_id FROM payments p JOIN bookings b ON b.id=p.booking_id JOIN yachts y ON y.id=b.yacht_id WHERE p.id=?").bind(reconcileMatch[1]).first<DbRow>());
    if (!payment || (actor.role === "vendor" && actor.vendor_id !== payment.vendor_id)) throw new HttpError("Payment not found", 404);
    if (env.BML_MODE !== "mock") throw new HttpError("Live BML reconciliation is not configured", 501);
    await syncBooking(env, payment.booking_id); await audit(env, actor, "payment_reconciled", "payment", payment.id, { status: payment.status });
    return json({ status: payment.status });
  }
  if (path === "/api/refunds") {
    const actor = await requireRole(request, env, ["admin"]), payment = await env.DB.prepare("SELECT * FROM payments WHERE id=? AND status='paid'").bind(data.payment_id).first<DbRow>();
    if (!payment) throw new HttpError("A paid payment is required");
    const prior = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) value FROM refunds WHERE payment_id=? AND status IN ('recorded','processed')").bind(payment.id).first<{ value: number }>();
    const amount = round(numberField(data, "amount", { minimum: .01, maximum: 100_000_000, required: true }) as number);
    if (amount <= 0 || Number(prior?.value || 0) + amount > Number(payment.amount) + .001) throw new HttpError("Invalid refund amount");
    const ratio = amount / Number(payment.amount), commission = round(Number(payment.commission_amount) * ratio), operator = round(Number(payment.operator_net_amount) * ratio);
    const refundStatus = env.BML_MODE === "mock" ? "processed" : "recorded";
    let insert: D1Result;
    try { insert = await env.DB.prepare("INSERT INTO refunds(payment_id,booking_id,amount,commission_reversal,operator_reversal,reason,status,created_at,processed_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(payment.id, payment.booking_id, amount, commission, operator, textField(data, "reason", 1_000) || null, refundStatus, timestamp, refundStatus === "processed" ? timestamp : null).run(); }
    catch (error) { if (/invalid refund total/i.test(error instanceof Error ? error.message : String(error))) throw new HttpError("Refund exceeds the remaining refundable amount", 409); throw error; }
    await syncBooking(env, payment.booking_id); await audit(env, actor, "refund_recorded", "refund", insert.meta.last_row_id, { amount, status: refundStatus }); return json({ id: insert.meta.last_row_id, amount, commission_reversal: commission, operator_reversal: operator, status: refundStatus }, 201);
  }
  if (path === "/api/admin/payouts") {
    const actor = await requireRole(request, env, ["admin"]), amount = round(numberField(data, "amount", { minimum: .01, maximum: 100_000_000, required: true }) as number);
    const idempotencyToken = requestToken(request, "idempotency-key"); if (idempotencyToken.length < 16 || idempotencyToken.length > 128) throw new HttpError("A valid Idempotency-Key header is required");
    const idempotencyKey = await sha256(idempotencyToken), existing = await env.DB.prepare("SELECT id,status FROM payouts WHERE idempotency_key=?").bind(idempotencyKey).first<DbRow>();
    if (existing) return json(existing, 200);
    const vendorId = numberField(data, "vendor_id", { integer: true, minimum: 1, required: true });
    const vendor = await env.DB.prepare("SELECT 1 FROM vendors WHERE id=?").bind(vendorId).first(); if (!vendor) throw new HttpError("Vendor not found", 404);
    const currency = textField(data, "currency", 3).toUpperCase() || "USD"; if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError("currency is invalid");
    const eligible = rows(await env.DB.prepare(`SELECT p.id,p.operator_net_amount-
      COALESCE((SELECT SUM(r.operator_reversal) FROM refunds r WHERE r.payment_id=p.id AND r.status IN ('recorded','processed')),0)-
      COALESCE((SELECT SUM(pi.amount) FROM payout_items pi JOIN payouts po ON po.id=pi.payout_id WHERE pi.payment_id=p.id AND po.status IN ('pending','paid')),0) available
      FROM payments p JOIN bookings b ON b.id=p.booking_id JOIN yachts y ON y.id=b.yacht_id
      WHERE y.vendor_id=? AND p.status='paid' AND p.currency=? ORDER BY p.id`).bind(vendorId, currency).all<DbRow>());
    let remaining = amount; const allocations: { paymentId: unknown; amount: number }[] = [];
    for (const payment of eligible) { const allocated = round(Math.min(remaining, Math.max(0, Number(payment.available)))); if (allocated > 0) allocations.push({ paymentId: payment.id, amount: allocated }); remaining = round(remaining - allocated); if (remaining <= 0) break; }
    if (remaining > .001) throw new HttpError("Payout exceeds the available balance", 409);
    const statements: D1PreparedStatement[] = [env.DB.prepare("INSERT INTO payouts(vendor_id,amount,currency,status,reference,notes,created_at,idempotency_key) VALUES(?,?,?,'pending',?,?,?,?)").bind(vendorId, amount, currency, textField(data, "reference", 160) || null, textField(data, "notes", 1_000) || null, timestamp, idempotencyKey)];
    for (const allocation of allocations) statements.push(env.DB.prepare("INSERT INTO payout_items(payout_id,payment_id,amount) SELECT id,?,? FROM payouts WHERE idempotency_key=?").bind(allocation.paymentId, allocation.amount, idempotencyKey));
    statements.push(env.DB.prepare("INSERT INTO audit_logs(actor_user_id,actor_role,action,entity_type,entity_id,detail_json,created_at) SELECT ?,?,'payout_created','payout',CAST(id AS TEXT),?,? FROM payouts WHERE idempotency_key=?").bind(actor.id, actor.role, JSON.stringify({ amount }), timestamp, idempotencyKey));
    try { await env.DB.batch(statements); }
    catch (error) { if (/payout exceeds/i.test(error instanceof Error ? error.message : String(error))) throw new HttpError("Payout exceeds the available balance", 409); throw error; }
    const created = await env.DB.prepare("SELECT id FROM payouts WHERE idempotency_key=?").bind(idempotencyKey).first<{ id: number }>(); return json({ id: created?.id, status: "pending" }, 201);
  }
  throw new HttpError("Unknown endpoint", 404);
}

function validateDeparture(data: DbRow): void {
  if (!validDates(data.start_date, data.end_date)) throw new HttpError("End date must follow start date");
  if (String(data.start_date) < now().slice(0, 10)) throw new HttpError("Departure cannot start in the past");
  const integerFields = ["nights", "cabins_total", "cabins_available", "places_total", "places_available"];
  for (const key of integerFields) numberField(data, key, { integer: true, minimum: key === "nights" ? 1 : 0, maximum: 10_000, required: true });
  numberField(data, "price_pp", { minimum: 0, maximum: 1_000_000, required: true });
  if (Number(data.nights) !== dateNights(String(data.start_date), String(data.end_date))) throw new HttpError("nights must match the departure dates");
  enumField(data, "status", ["open", "closed"], "open");
  textField(data, "title", 160, true);
  if (Number(data.cabins_available) > Number(data.cabins_total)) throw new HttpError("Available cabins cannot exceed total cabins");
  if (Number(data.places_available) > Number(data.places_total)) throw new HttpError("Available places cannot exceed total places");
}
function itineraryField(value: unknown): DbRow[] {
  if (value == null || value === "") return [];
  if (!Array.isArray(value) || value.length > 40) throw new HttpError("itinerary must be an array of days");
  const days = value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError("itinerary day is invalid");
    const item = raw as DbRow, day = Number(item.day), title = String(item.title || "").trim(), description = String(item.description || "").trim();
    if (!Number.isInteger(day) || day < 1 || day > 100 || !title || title.length > 160 || description.length > 2_000) throw new HttpError(`itinerary day ${index + 1} is invalid`);
    if (!Array.isArray(item.locations) || item.locations.length > 20) throw new HttpError(`itinerary day ${index + 1} locations are invalid`);
    const locations = item.locations.map((location) => String(location).trim()).filter(Boolean);
    if (locations.some((location) => location.length > 120)) throw new HttpError(`itinerary day ${index + 1} locations are invalid`);
    return { day, title, locations, description };
  });
  if (new Set(days.map((item) => item.day)).size !== days.length) throw new HttpError("itinerary day numbers must be unique");
  return days.sort((a, b) => Number(a.day) - Number(b.day));
}

async function putApi(request: Request, env: Env, url: URL): Promise<Response> {
  const data = await body(request), path = url.pathname, timestamp = now();
  const reviewModeration=path.match(/^\/api\/admin\/reviews\/(\d+)$/);
  if(reviewModeration){const actor=await requireRole(request,env,["admin"]),status=enumField(data,"status",["approved","rejected","hidden"]);const result=await env.DB.prepare("UPDATE reviews SET status=?,admin_note=?,moderated_at=?,moderated_by=?,updated_at=? WHERE id=?").bind(status,textField(data,"admin_note",1000)||null,timestamp,actor.id,timestamp,reviewModeration[1]).run();if(!result.meta.changes)throw new HttpError("Review not found",404);await audit(env,actor,"moderate","review",reviewModeration[1],{status});return json({ok:true,status});}
  const supportUpdate=path.match(/^\/api\/admin\/support\/(\d+)$/);
  if(supportUpdate){const actor=await requireRole(request,env,["admin"]),status=enumField(data,"status",["new","open","waiting","resolved","closed"]);const result=await env.DB.prepare("UPDATE support_requests SET status=?,admin_notes=?,updated_at=? WHERE id=?").bind(status,textField(data,"admin_notes",4000)||null,timestamp,supportUpdate[1]).run();if(!result.meta.changes)throw new HttpError("Support request not found",404);await audit(env,actor,"update","support_request",supportUpdate[1],{status});return json({ok:true,status});}
  const managedUpdate=path.match(/^\/api\/admin\/(support-profiles|trust-marks)\/(\d+)$/);
  if(managedUpdate){const actor=await requireRole(request,env,["admin"]),table=managedUpdate[1]==="support-profiles"?"support_profiles":"trust_marks",sets:string[]=[],values:unknown[]=[];for(const field of table==="support_profiles"?["active","sort_order"]:["active","verified","sort_order"]){if(field in data){sets.push(`${field}=?`);values.push(field==="sort_order"?numberField(data,field,{integer:true,minimum:0,maximum:10000,required:true}):Number(bool(data[field])))}}if(!sets.length)throw new HttpError("No supported fields supplied");sets.push("updated_at=?");values.push(timestamp,managedUpdate[2]);const result=await env.DB.prepare(`UPDATE ${table} SET ${sets.join(",")} WHERE id=?`).bind(...values).run();if(!result.meta.changes)throw new HttpError("Not found",404);await audit(env,actor,"update",table,managedUpdate[2],data);return json({ok:true});}
  if (path === "/api/admin/settings") {
    const actor = await requireRole(request, env, ["admin"]), ranges: Record<string, [number, number] | null> = { commission_rate: [0, 100], deposit_percent: [0, 100], hold_minutes: [5, 1440], currency: null,booking_conditions_version:null,booking_conditions_intro:null,best_price_guarantee_enabled:null,best_price_guarantee_text:null,hero_eyebrow:null,hero_title:null,hero_text:null,support_always_available:null }, changed: DbRow = {};
    const statements: D1PreparedStatement[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (!(key in ranges)) throw new HttpError(`Unknown setting: ${key}`); const range = ranges[key];
      if (range && (!Number.isFinite(Number(value)) || Number(value) < range[0] || Number(value) > range[1])) throw new HttpError(`${key} out of range`);
      if (key === "currency" && !/^[A-Z]{3}$/.test(String(value))) throw new HttpError("currency must be a three-letter uppercase code");
      changed[key] = value; statements.push(env.DB.prepare("INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(key, String(value), timestamp));
    }
    if (statements.length) await env.DB.batch(statements); await audit(env, actor, "settings_update", "platform_settings", null, changed); return json({ ok: true, ...changed });
  }
  const cabinTypeMatch = path.match(/^\/api\/cabin-types\/(\d+)$/);
  if (cabinTypeMatch) {
    const actor = await requireRole(request,env,["vendor","admin"]), current = row(await env.DB.prepare("SELECT c.*,y.vendor_id FROM yacht_cabin_types c JOIN yachts y ON y.id=c.yacht_id WHERE c.id=?").bind(cabinTypeMatch[1]).first<DbRow>());
    if (!current || (actor.role === "vendor" && current.vendor_id !== actor.vendor_id)) throw new HttpError("Cabin type not found",404);
    const merged={...current,...data}, name=textField(merged,"name",120,true), capacity=numberField(merged,"capacity",{integer:true,minimum:1,maximum:20,required:true});
    const gallery=Array.isArray(merged.gallery)?merged.gallery.map(String).slice(0,30):[],modes=Array.isArray(merged.occupancy_modes)?merged.occupancy_modes.map(String).filter(x=>["shared","private"].includes(x)):[];
    await env.DB.prepare("UPDATE yacht_cabin_types SET name=?,deck=?,bed_configuration=?,description=?,image=?,gallery_json=?,window_type=?,air_conditioning=?,ensuite=?,occupancy_modes_json=?,capacity=?,sort_order=?,active=?,updated_at=? WHERE id=?").bind(name,textField(merged,"deck",80)||null,textField(merged,"bed_configuration",120)||null,textField(merged,"description",1000)||null,urlField(merged,"image"),JSON.stringify(gallery),textField(merged,"window_type",80)||null,Number(bool(merged.air_conditioning)),Number(bool(merged.ensuite)),JSON.stringify(modes.length?modes:["private"]),capacity,numberField(merged,"sort_order",{integer:true,minimum:0,maximum:1000})||0,Number("active" in data?bool(data.active):bool(current.active)),timestamp,cabinTypeMatch[1]).run();
    await audit(env,actor,"update","cabin_type",cabinTypeMatch[1],{fields:Object.keys(data)});return json({ok:true});
  }
  for (const [pattern, roles, sql, action] of [
    [/^\/api\/admin\/vendors\/(\d+)$/, ["admin"], "UPDATE vendors SET verified=?,status=?,updated_at=? WHERE id=?", "vendor_verification"],
    [/^\/api\/admin\/documents\/(\d+)$/, ["admin"], "UPDATE vendor_documents SET status=?,note=?,reviewed_at=?,reviewed_by=? WHERE id=?", "document_review"],
    [/^\/api\/admin\/payouts\/(\d+)$/, ["admin"], "UPDATE payouts SET status=?,reference=COALESCE(?,reference),paid_at=? WHERE id=?", "payout_status"],
    [/^\/api\/admin\/yachts\/(\d+)$/, ["admin"], "UPDATE yachts SET verified=?,verification_note=?,status=COALESCE(?,status),updated_at=? WHERE id=?", "yacht_verification"]
  ] as const) {
    const match = path.match(pattern); if (!match) continue; const actor = await requireRole(request, env, [...roles]);
    if (action === "vendor_verification") enumField(data, "status", ["pending", "verified", "suspended"], bool(data.verified) ? "verified" : "pending");
    if (action === "document_review") enumField(data, "status", ["pending", "approved", "rejected"], "approved");
    if (action === "payout_status") enumField(data, "status", ["pending", "paid", "cancelled"], "paid");
    if (action === "yacht_verification" && data.status != null) enumField(data, "status", ["draft", "live"]);
    const values = action === "vendor_verification" ? [Number(bool(data.verified)), data.status || (bool(data.verified) ? "verified" : "pending"), timestamp, match[1]]
      : action === "document_review" ? [data.status || "approved", data.note || null, timestamp, actor.id, match[1]]
      : action === "payout_status" ? [data.status || "paid", data.reference || null, (data.status || "paid") === "paid" ? timestamp : null, match[1]]
      : [Number(bool(data.verified)), data.verification_note || null, data.status || null, timestamp, match[1]];
    const result = await env.DB.prepare(sql).bind(...values).run(); if (!result.meta.changes) throw new HttpError("Not found", 404);
    if (action === "payout_status") await env.DB.prepare("UPDATE payments SET payout_status=? WHERE id IN (SELECT payment_id FROM payout_items WHERE payout_id=?)").bind((data.status || "paid") === "paid" ? "paid" : "pending", match[1]).run();
    await audit(env, actor, action, action.split("_")[0], match[1], data); return json({ ok: true });
  }
  const yachtMatch = path.match(/^\/api\/yachts\/(\d+)$/);
  if (yachtMatch) {
    const actor = await requireRole(request, env, ["vendor", "admin"]), yacht = row(await env.DB.prepare("SELECT * FROM yachts WHERE id=?").bind(yachtMatch[1]).first<DbRow>());
    if (!yacht) throw new HttpError("Not found", 404); if (actor.role === "vendor" && yacht.vendor_id !== actor.vendor_id) throw new HttpError("Forbidden", 403);
    const privateEnabled = "private_enabled" in data ? bool(data.private_enabled) : bool(yacht.private_enabled), sharedEnabled = "shared_enabled" in data ? bool(data.shared_enabled) : bool(yacht.shared_enabled);
    if (!privateEnabled && !sharedEnabled) throw new HttpError("At least one booking model must be enabled");
    if ("name" in data) data.name = textField(data, "name", 120, true);
    if ("type" in data) data.type = textField(data, "type", 80, true);
    if ("status" in data) {
      data.status = enumField(data, "status", ["draft", "live"]);
      if (actor.role === "vendor" && data.status === "live" && !yacht.verified) throw new HttpError("The listing must be verified before it can go live", 403);
    }
    for (const field of ["guests", "cabins", "crew"]) if (field in data) data[field] = numberField(data, field, { integer: true, minimum: field === "guests" || field === "cabins" ? 1 : 0, maximum: 200, required: true });
    for (const field of ["year_built", "year_refit"]) if (field in data) data[field] = numberField(data, field, { integer: true, minimum: 1800, maximum: 2200 });
    if ("length_m" in data) data.length_m = numberField(data, "length_m", { minimum: 0, maximum: 300, required: true });
    const privateOptions = privateSettings(data, yacht);
    for (const field of ["private_rate", "shared_rate"]) if (field in data) data[field] = numberField(data, field, { minimum: 0, maximum: 10_000_000 });
    if ("private_rate_public" in data) data.private_rate_public = Number(privateOptions.ratePublic);
    if ("private_instant_booking" in data) data.private_instant_booking = Number(privateOptions.instantBooking);
    if ("private_min_nights" in data) data.private_min_nights = privateOptions.minNights;
    if ("private_max_nights" in data) data.private_max_nights = privateOptions.maxNights;
    if ("description" in data) data.description = textField(data, "description", 10_000);
    if ("image" in data) data.image = urlField(data, "image");
    for (const field of ["amenities", "experiences"]) if (field in data) data[field] = stringList(data, field);
    if ("gallery" in data) { const gallery = stringList(data, "gallery", 100); for (const value of gallery) { try { if (new URL(value).protocol !== "https:") throw new Error(); } catch { throw new HttpError("gallery must contain HTTPS URLs"); } } data.gallery = gallery; }
    const allowed = ["name", "type", "status", "private_enabled", "shared_enabled", "guests", "cabins", "crew", "length_m", "year_built", "year_refit", "description", "image", "private_rate", "private_rate_public", "private_instant_booking", "private_min_nights", "private_max_nights", "shared_rate"];
    const sets: string[] = [], values: unknown[] = [];
    for (const field of allowed) if (field in data) { sets.push(`${field}=?`); values.push(field === "private_enabled" ? Number(privateEnabled) : field === "shared_enabled" ? Number(sharedEnabled) : data[field]); }
    for (const field of ["amenities", "experiences", "gallery"]) if (field in data) { sets.push(`${field}_json=?`); values.push(JSON.stringify(data[field])); }
    if (sets.length) { sets.push("updated_at=?"); values.push(timestamp, yachtMatch[1]); await env.DB.prepare(`UPDATE yachts SET ${sets.join(",")} WHERE id=?`).bind(...values).run(); }
    await audit(env, actor, "update", "yacht", yachtMatch[1], { fields: Object.keys(data) }); return json({ ok: true });
  }
  const departureMatch = path.match(/^\/api\/departures\/(\d+)$/);
  if (departureMatch) {
    const actor = await requireRole(request, env, ["vendor", "admin"]), current = row(await env.DB.prepare("SELECT d.*,y.vendor_id,y.shared_enabled FROM departures d JOIN yachts y ON y.id=d.yacht_id WHERE d.id=?").bind(departureMatch[1]).first<DbRow>());
    if (!current) throw new HttpError("Departure not found", 404); if (actor.role === "vendor" && current.vendor_id !== actor.vendor_id) throw new HttpError("Forbidden", 403);
    const merged = { ...current, ...data }; validateDeparture(merged);
    const reserved = await env.DB.prepare("SELECT COALESCE(SUM(units),0) places,COALESCE(SUM(cabin_units),0) cabins FROM availability_holds WHERE departure_id=? AND status='active' AND expires_at>?").bind(departureMatch[1], timestamp).first<DbRow>();
    if (Number(merged.places_available) < Number(reserved?.places || 0) || Number(merged.cabins_available) < Number(reserved?.cabins || 0)) throw new HttpError("Inventory cannot be reduced below active reservations", 409);
    const itinerary = "itinerary" in data ? itineraryField(data.itinerary) : (Array.isArray(current.itinerary) ? current.itinerary : []);
    const bookingConditions="booking_conditions" in data&&data.booking_conditions&&typeof data.booking_conditions==="object"&&!Array.isArray(data.booking_conditions)?data.booking_conditions:(current.booking_conditions||{});
    const statements: D1PreparedStatement[] = [env.DB.prepare("UPDATE departures SET title=?,start_date=?,end_date=?,nights=?,cabins_total=?,cabins_available=?,places_total=?,places_available=?,price_pp=?,status=?,embarkation=?,disembarkation=?,itinerary_json=?,booking_conditions_json=? WHERE id=?").bind(merged.title, merged.start_date, merged.end_date, merged.nights, merged.cabins_total, merged.cabins_available, merged.places_total, merged.places_available, merged.price_pp, merged.status || "open",textField(merged,"embarkation",160)||null,textField(merged,"disembarkation",160)||null,JSON.stringify(itinerary),JSON.stringify(bookingConditions),departureMatch[1])];
    if (Array.isArray(data.cabin_inventory)) for (const rawItem of data.cabin_inventory) { const item=rawItem as DbRow,typeId=numberField(item,"cabin_type_id",{integer:true,minimum:1,required:true}),total=numberField(item,"cabins_total",{integer:true,minimum:0,required:true}),available=numberField(item,"cabins_available",{integer:true,minimum:0,required:true}),price=numberField(item,"price_pp",{minimum:0,required:true}),list=numberField(item,"list_price_pp",{minimum:0})??price,low=numberField(item,"low_stock_threshold",{integer:true,minimum:0})??4,single=numberField(item,"single_occupancy_surcharge_percent",{minimum:0,maximum:500})??0,privacy=numberField(item,"privacy_surcharge_percent",{minimum:0,maximum:500})??0;if(Number(available)>Number(total))throw new HttpError("Cabin category availability cannot exceed its total");const held=await env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN hi.inventory_units>0 THEN hi.inventory_units ELSE hi.cabins*c.capacity END),0) units,MAX(c.capacity) capacity FROM availability_hold_cabin_items hi JOIN availability_holds h ON h.id=hi.hold_id JOIN yacht_cabin_types c ON c.id=hi.cabin_type_id WHERE hi.departure_id=? AND hi.cabin_type_id=? AND h.status='active' AND h.expires_at>?").bind(departureMatch[1],typeId,timestamp).first<DbRow>();if(Number(available)*Number(held?.capacity||1)<Number(held?.units||0))throw new HttpError("Cabin category inventory cannot be reduced below active reservations",409);statements.push(env.DB.prepare("INSERT INTO departure_cabin_inventory(departure_id,cabin_type_id,cabins_total,cabins_available,price_pp,list_price_pp,promotion_label,promotion_starts_at,promotion_ends_at,low_stock_threshold,single_occupancy_surcharge_percent,privacy_surcharge_percent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(departure_id,cabin_type_id) DO UPDATE SET cabins_total=excluded.cabins_total,cabins_available=excluded.cabins_available,price_pp=excluded.price_pp,list_price_pp=excluded.list_price_pp,promotion_label=excluded.promotion_label,promotion_starts_at=excluded.promotion_starts_at,promotion_ends_at=excluded.promotion_ends_at,low_stock_threshold=excluded.low_stock_threshold,single_occupancy_surcharge_percent=excluded.single_occupancy_surcharge_percent,privacy_surcharge_percent=excluded.privacy_surcharge_percent").bind(departureMatch[1],typeId,total,available,price,list,textField(item,"promotion_label",80)||null,textField(item,"promotion_starts_at",40)||null,textField(item,"promotion_ends_at",40)||null,low,single,privacy)); }
    await env.DB.batch(statements);
    await audit(env, actor, "update", "departure", departureMatch[1], { fields: Object.keys(data) }); return json({ ok: true });
  }
  const bookingMatch = path.match(/^\/api\/bookings\/(\d+)$/);
  if (bookingMatch) {
    const actor = await requireRole(request, env, ["vendor", "admin"]), booking = await env.DB.prepare("SELECT b.*,y.vendor_id FROM bookings b JOIN yachts y ON y.id=b.yacht_id WHERE b.id=?").bind(bookingMatch[1]).first<DbRow>();
    if (!booking) throw new HttpError("Not found", 404); if (actor.role === "vendor" && booking.vendor_id !== actor.vendor_id) throw new HttpError("Forbidden", 403);
    const status = enumField(data, "status", ["approved", "declined", "cancelled", "confirmed", "completed", "awaiting_payment"]);
    const transitions: Record<string, string[]> = {
      pending_operator: ["approved", "confirmed", "declined", "cancelled"], approved: ["awaiting_payment", "confirmed", "declined", "cancelled"],
      awaiting_payment: ["confirmed", "cancelled"], confirmed: ["completed", "cancelled"], completed: [], declined: [], cancelled: []
    };
    if (!(transitions[String(booking.status)] || []).includes(status)) throw new HttpError(`Cannot change a ${booking.status} booking to ${status}`, 409);
    const extending = ["approved", "awaiting_payment"].includes(status);
    if (extending) {
      const hold = await env.DB.prepare("SELECT 1 FROM availability_holds WHERE booking_id=? AND status='active' AND expires_at>?").bind(bookingMatch[1], timestamp).first();
      if (!hold) throw new HttpError("The availability hold has expired", 409);
    }
    const expires = new Date(Date.now() + Number(await setting(env, "hold_minutes", "30")) * 60_000).toISOString();
    const statements: D1PreparedStatement[] = [
      env.DB.prepare("UPDATE bookings SET status=?,expires_at=CASE WHEN ? THEN ? ELSE expires_at END,updated_at=? WHERE id=?").bind(status, Number(extending), expires, timestamp, bookingMatch[1]),
      env.DB.prepare("INSERT INTO notifications(vendor_id,booking_id,channel,subject,body,status,created_at,sent_at) VALUES(?,?, 'in_app','Booking update',?,'sent',?,?)").bind(booking.vendor_id, bookingMatch[1], `Booking ${booking.booking_ref} is now ${status}.`, timestamp, timestamp),
      env.DB.prepare("INSERT INTO audit_logs(actor_user_id,actor_role,action,entity_type,entity_id,detail_json,created_at) VALUES(?,?,'booking_status','booking',?,?,?)").bind(actor.id, actor.role, bookingMatch[1], JSON.stringify({ status }), timestamp)
    ];
    if (["declined", "cancelled", "completed"].includes(status)) statements.push(env.DB.prepare("UPDATE availability_holds SET status='released' WHERE booking_id=?").bind(bookingMatch[1]));
    else if (extending) statements.push(env.DB.prepare("UPDATE availability_holds SET expires_at=? WHERE booking_id=? AND status='active'").bind(expires, bookingMatch[1]));
    await env.DB.batch(statements); return json({ ok: true, status });
  }
  throw new HttpError("Unknown endpoint", 404);
}

async function deleteApi(request:Request,env:Env,url:URL):Promise<Response>{
  const match=url.pathname.match(/^\/api\/account\/wishlist\/(\d+)$/);if(!match)throw new HttpError("Unknown endpoint",404);
  const actor=await requireRole(request,env,["guest","vendor","admin"]);await env.DB.prepare("DELETE FROM wishlists WHERE user_id=? AND yacht_id=?").bind(actor.id,match[1]).run();await audit(env,actor,"unsave","yacht",match[1]);return json({ok:true});
}

async function api(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "GET") return await getApi(request, env, ctx, url);
    if (request.method === "POST") return await postApi(request, env, url);
    if (request.method === "PUT") return await putApi(request, env, url);
    if (request.method === "DELETE") return await deleteApi(request, env, url);
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: { ...JSON_HEADERS, allow: "GET, POST, PUT, DELETE" } });
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    console.error(JSON.stringify({ level: "error", path: url.pathname, error: error instanceof Error ? error.stack : String(error) }));
    return json({ error: "Internal server error" }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "www.maldivesliveaboardbooking.com") {
      url.hostname = "maldivesliveaboardbooking.com";
      return Response.redirect(url.toString(), 308);
    }
    if (url.pathname.startsWith("/api/")) return api(request, env, ctx);
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("x-content-type-options", "nosniff"); headers.set("x-frame-options", "DENY");
    headers.set("referrer-policy", "strict-origin-when-cross-origin"); headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    headers.set("content-security-policy", JSON_HEADERS["content-security-policy"]);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const result = await env.DB.prepare("UPDATE availability_holds SET status='expired' WHERE status='active' AND expires_at<=?").bind(now()).run();
    console.log(JSON.stringify({ event: "expired_hold_cleanup", changes: result.meta.changes, rows_written: result.meta.rows_written }));
  },
} satisfies ExportedHandler<Env>;
