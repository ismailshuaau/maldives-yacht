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

type DbRow = Record<string, unknown>;
function row(raw: DbRow | null): DbRow | null {
  if (!raw) return null;
  const item = { ...raw };
  for (const key of ["amenities_json", "experiences_json", "gallery_json", "detail_json", "raw_response"]) {
    if (!(key in item)) continue;
    try {
      const parsed = JSON.parse(String(item[key] || (key.endsWith("_json") ? "[]" : "{}")));
      if (key.endsWith("_json")) { item[key.slice(0, -5)] = parsed; delete item[key]; }
      else item[key] = parsed;
    } catch { /* Preserve malformed legacy data for inspection. */ }
  }
  for (const key of ["private_enabled", "shared_enabled", "mock_generated", "verified", "active"]) {
    if (key in item) item[key] = bool(item[key]);
  }
  if (Array.isArray(item.experiences)) item.experiences = item.experiences.map((value) => String(value).toLowerCase() === "shared liveaboard" ? "Liveaboard" : value);
  return item;
}
function rows(result: D1Result<DbRow>): DbRow[] { return result.results.map((item) => row(item) as DbRow); }
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
  if (actor?.role === "admin" || (actor?.role === "vendor" && actor.vendor_id === booking.vendor_id)) return true;
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
async function expireHolds(env: Env): Promise<void> {
  await env.DB.prepare("UPDATE availability_holds SET status='expired' WHERE status='active' AND expires_at < ?").bind(now()).run();
}
async function overlap(env: Env, yachtId: unknown, start: string, end: string): Promise<boolean> {
  await expireHolds(env);
  return Boolean(await env.DB.prepare(`SELECT 1 present FROM availability_holds WHERE yacht_id=? AND status='active'
    AND departure_id IS NULL AND date(start_date)<date(?) AND date(end_date)>date(?) LIMIT 1`).bind(yachtId, end, start).first());
}
async function departure(env: Env, raw: DbRow): Promise<DbRow> {
  const item = row(raw) as DbRow;
  const reserved = await env.DB.prepare(`SELECT COALESCE(SUM(units),0) places,COALESCE(SUM(cabin_units),0) cabins
    FROM availability_holds WHERE departure_id=? AND status='active' AND expires_at>?`).bind(item.id, now()).first<DbRow>();
  item.places_remaining = Math.max(0, Number(item.places_available || 0) - Number(reserved?.places || 0));
  item.cabins_remaining = Math.max(0, Number(item.cabins_available || 0) - Number(reserved?.cabins || 0));
  return item;
}
function joinedDeparture(raw: DbRow): DbRow {
  const item = row(raw) as DbRow;
  item.places_remaining = Math.max(0, Number(item.places_available || 0) - Number(item.reserved_places || 0));
  item.cabins_remaining = Math.max(0, Number(item.cabins_available || 0) - Number(item.reserved_cabins || 0));
  delete item.reserved_places; delete item.reserved_cabins;
  return item;
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
  return found.results.map(joinedDeparture);
}
function validDates(start: unknown, end: unknown): boolean {
  return typeof start === "string" && typeof end === "string" && validCalendarDate(start) && validCalendarDate(end) && end > start;
}
function dateNights(start: string, end: string): number { return Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000); }

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
  if (mode === "private") {
    if (!yacht.private_enabled) throw new HttpError("Private charter unavailable", 409);
    if (!validDates(start, end)) throw new HttpError("Valid start_date and end_date are required");
    if (start < now().slice(0, 10)) throw new HttpError("Start date cannot be in the past");
    nights = dateNights(start, end);
    if (guests > Number(yacht.guests)) throw new HttpError("Guest count exceeds yacht capacity");
    if (await overlap(env, yacht.id, start, end)) throw new HttpError("These dates are no longer available", 409);
    total = round(Number(yacht.private_rate || 0) * nights);
    departureId = null;
  } else {
    if (!yacht.shared_enabled) throw new HttpError("Liveaboard unavailable", 409);
    cabinsBooked = Number(data.cabins_booked);
    if (!Number.isInteger(cabinsBooked) || cabinsBooked < 1 || cabinsBooked > guests) throw new HttpError("Cabins must be between one and the number of guests");
    await expireHolds(env);
    const raw = await env.DB.prepare("SELECT * FROM departures WHERE id=? AND yacht_id=? AND status='open'").bind(departureId, yacht.id).first<DbRow>();
    if (!raw) throw new HttpError("Liveaboard departure not found", 404);
    departureRow = await departure(env, raw);
    if (String(departureRow.end_date) < now().slice(0, 10)) throw new HttpError("This departure has ended", 409);
    if (guests > Number(departureRow.places_remaining)) throw new HttpError("Not enough passenger places remain", 409);
    if (cabinsBooked > Number(departureRow.cabins_remaining)) throw new HttpError("Not enough cabins remain", 409);
    start = String(departureRow.start_date); end = String(departureRow.end_date); nights = Number(departureRow.nights);
    total = round(Number(departureRow.price_pp || 0) * guests);
  }
  const depositPercent = Math.max(0, Math.min(100, Number(await setting(env, "deposit_percent", "30"))));
  const deposit = round(total * depositPercent / 100), currency = await setting(env, "currency", "USD");
  return { yacht, departure: departureRow, departureId, mode, guests, cabinsBooked, start, end, nights, total, depositPercent, deposit, balance: round(total - deposit), currency };
}

function quoteResponse(selection: BookingSelection): DbRow {
  return {
    yacht_id: selection.yacht.id, mode: selection.mode, departure_id: selection.departureId,
    start_date: selection.start, end_date: selection.end, nights: selection.nights,
    guests: selection.guests, cabins_booked: selection.cabinsBooked,
    total: selection.total, total_amount: selection.total, deposit_percent: selection.depositPercent,
    deposit_amount: selection.deposit, balance: selection.balance, balance_amount: selection.balance, currency: selection.currency,
  };
}

async function getApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  if (path === "/api/health") {
    const health = { ok: true, time: now(), environment: env.ENVIRONMENT, auth_enforced: env.ENFORCE_AUTH === "1" };
    if (env.ENVIRONMENT !== "staging") return json(health);
    return json({
      ...health,
      demo_accounts: [
        { role: "admin", email: "admin@atolle.mv", password: "AtolleAdmin123!" },
        { role: "vendor", email: "operator@example.com", password: "AtolleVendor123!" },
      ],
    });
  }
  if (path === "/api/auth/me") {
    const actor = await userFor(request, env);
    if (!actor) return json({ authenticated: false }, 401);
    delete actor.password_hash;
    return json(actor);
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
    yacht.available_months = availableMonths;
    yacht.departure_meta = {
      selected_month: month || null,
      total_open: allDepartures.length,
      returned: (yacht.departures as unknown[]).length,
      next_available_month: availableMonths.find((value) => value >= now().slice(0, 7)) || availableMonths[0] || null,
    };
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
    return json(rows(await env.DB.prepare(`${sql} ORDER BY b.id DESC`).bind(...values).all<DbRow>()));
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
    return json(found.map(joinedDeparture));
  }
  const bookingMatch = path.match(/^\/api\/bookings\/(\d+)$/);
  if (bookingMatch) {
    const actor = await requireRole(request, env, ["vendor", "admin"]);
    const booking = row(await env.DB.prepare("SELECT b.*,y.name yacht_name,y.vendor_id FROM bookings b JOIN yachts y ON y.id=b.yacht_id WHERE b.id=?").bind(bookingMatch[1]).first<DbRow>());
    if (!booking) throw new HttpError("Not found", 404);
    if (actor.role === "vendor" && actor.vendor_id !== booking.vendor_id) throw new HttpError("Forbidden", 403);
    booking.payments = (await env.DB.prepare("SELECT * FROM payments WHERE booking_id=? ORDER BY id").bind(bookingMatch[1]).all<DbRow>()).results.map(safePayment);
    booking.refunds = rows(await env.DB.prepare("SELECT * FROM refunds WHERE booking_id=? ORDER BY id").bind(bookingMatch[1]).all<DbRow>());
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
  if (path === "/api/bookings/quote") return json(quoteResponse(await bookingSelection(env, data)));
  if (path === "/api/bookings") {
    const idempotencyToken = requestToken(request, "idempotency-key");
    if (idempotencyToken.length < 16 || idempotencyToken.length > 128) throw new HttpError("A valid Idempotency-Key header is required");
    const idempotencyKey = await sha256(idempotencyToken);
    const prior = row(await env.DB.prepare("SELECT * FROM bookings WHERE idempotency_key=?").bind(idempotencyKey).first<DbRow>());
    if (prior) return json({ id: prior.id, booking_ref: prior.booking_ref, status: prior.status, total_amount: prior.total_amount, deposit_percent: prior.deposit_percent, deposit_amount: prior.deposit_amount, balance_due: prior.balance_due, currency: prior.currency, hold_expires_at: prior.expires_at, booking_token: idempotencyToken }, 200);
    const selection = await bookingSelection(env, data);
    const { yacht, departureId, mode, guests, cabinsBooked, start, end, nights, total, depositPercent, deposit, currency } = selection;
    const guestName = textField(data, "guest_name", 120, true), email = emailField(data);
    const phone = textField(data, "phone", 40) || null, notes = textField(data, "notes", 2_000) || null;
    const refBytes = crypto.getRandomValues(new Uint8Array(8));
    const ref = `ATL-${timestamp.slice(2, 10).replaceAll("-", "")}-${hex(refBytes.buffer).toUpperCase()}`;
    const expires = new Date(Date.now() + Number(await setting(env, "hold_minutes", "30")) * 60_000).toISOString();
    const actor = await userFor(request, env);
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO bookings(booking_ref,yacht_id,departure_id,mode,guest_name,email,phone,guests,cabins_booked,start_date,end_date,nights,total_amount,deposit_percent,deposit_amount,amount_paid,balance_due,currency,status,payment_status,notes,expires_at,created_at,updated_at,access_token_hash,idempotency_key)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?, 'pending_operator','unpaid',?,?,?, ?,?,?)`).bind(ref, yacht.id, departureId, mode, guestName, email, phone, guests, cabinsBooked, start, end, nights, total, depositPercent, deposit, total, currency, notes, expires, timestamp, timestamp, idempotencyKey, idempotencyKey),
        env.DB.prepare("INSERT INTO availability_holds(booking_id,yacht_id,departure_id,start_date,end_date,units,cabin_units,expires_at,status,created_at) SELECT id,?,?,?,?,?,?,?,'active',? FROM bookings WHERE booking_ref=?").bind(yacht.id, departureId, start, end, mode === "shared" ? guests : 1, cabinsBooked, expires, timestamp, ref),
        env.DB.prepare("INSERT INTO notifications(vendor_id,booking_id,channel,subject,body,status,created_at,sent_at) SELECT ?,id,'in_app','New booking request',?,'sent',?,? FROM bookings WHERE booking_ref=?").bind(yacht.vendor_id, `New ${mode} booking request ${ref} for ${yacht.name}.`, timestamp, timestamp, ref),
        env.DB.prepare("INSERT INTO audit_logs(actor_user_id,actor_role,action,entity_type,entity_id,detail_json,created_at) SELECT ?,?,'create','booking',CAST(id AS TEXT),?,? FROM bookings WHERE booking_ref=?").bind(actor?.id || null, actor?.role || "guest", JSON.stringify({ ref, total }), timestamp, ref)
      ]);
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
    const booking = row(await env.DB.prepare("SELECT b.*,y.vendor_id FROM bookings b JOIN yachts y ON y.id=b.yacht_id WHERE b.id=?").bind(data.booking_id).first<DbRow>());
    if (!booking) throw new HttpError("Booking not found", 404);
    if (!(await canAccessBooking(request, env, booking))) throw new HttpError("Booking not found", 404);
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
    const yacht = await env.DB.prepare("SELECT 1 FROM yachts WHERE id=? AND status='live' AND verified=1").bind(yachtId).first();
    if (!yacht) throw new HttpError("Yacht not found", 404);
    const guestName = textField(data, "guest_name", 120, true), email = emailField(data);
    const guests = numberField(data, "guests", { integer: true, minimum: 1, maximum: 200 });
    const experience = textField(data, "experience", 120) || null, message = textField(data, "message", 2_000) || null;
    const insert = await env.DB.prepare("INSERT INTO enquiries(yacht_id,guest_name,email,guests,experience,message,status,created_at) VALUES(?,?,?,?,?,?, 'new',?)").bind(yachtId, guestName, email, guests, experience, message, timestamp).run();
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
    const privateRate = numberField(data, "private_rate", { minimum: 0, maximum: 10_000_000 });
    const sharedRate = numberField(data, "shared_rate", { minimum: 0, maximum: 1_000_000 });
    const description = textField(data, "description", 10_000) || null, image = urlField(data, "image");
    const amenities = stringList(data, "amenities"), experiences = stringList(data, "experiences");
    const gallery = stringList(data, "gallery", 100); for (const value of gallery) { try { if (new URL(value).protocol !== "https:") throw new Error(); } catch { throw new HttpError("gallery must contain HTTPS URLs"); } }
    const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const insert = await env.DB.prepare(`INSERT INTO yachts(vendor_id,name,slug,type,status,private_enabled,shared_enabled,guests,cabins,crew,length_m,year_built,year_refit,description,image,private_rate,shared_rate,amenities_json,experiences_json,gallery_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(vendorId, name, slug, type, status, Number(privateEnabled), Number(sharedEnabled), guests, cabins, crew, length, numberField(data, "year_built", { integer: true, minimum: 1800, maximum: 2200 }), numberField(data, "year_refit", { integer: true, minimum: 1800, maximum: 2200 }), description, image, privateRate, sharedRate, JSON.stringify(amenities), JSON.stringify(experiences), JSON.stringify(gallery), timestamp).run();
    await audit(env, actor, "create", "yacht", insert.meta.last_row_id, { name }); return json({ id: insert.meta.last_row_id }, 201);
  }
  const newDeparture = path.match(/^\/api\/yachts\/(\d+)\/departures$/);
  if (newDeparture) {
    const actor = await requireRole(request, env, ["vendor", "admin"]), yacht = row(await env.DB.prepare("SELECT * FROM yachts WHERE id=?").bind(newDeparture[1]).first<DbRow>());
    if (!yacht) throw new HttpError("Yacht not found", 404);
    if (actor.role === "vendor" && yacht.vendor_id !== actor.vendor_id) throw new HttpError("Forbidden", 403);
    if (!yacht.shared_enabled) throw new HttpError("Yacht must have Liveaboard enabled");
    validateDeparture(data);
    const insert = await env.DB.prepare("INSERT INTO departures(yacht_id,title,start_date,end_date,nights,cabins_total,cabins_available,places_total,places_available,price_pp,status,mock_generated) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)").bind(newDeparture[1], data.title, data.start_date, data.end_date, data.nights, data.cabins_total, data.cabins_available, data.places_total, data.places_available, data.price_pp, data.status || "open").run();
    await audit(env, actor, "create", "departure", insert.meta.last_row_id, { yacht_id: newDeparture[1] }); return json({ id: insert.meta.last_row_id }, 201);
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

async function putApi(request: Request, env: Env, url: URL): Promise<Response> {
  const data = await body(request), path = url.pathname, timestamp = now();
  if (path === "/api/admin/settings") {
    const actor = await requireRole(request, env, ["admin"]), ranges: Record<string, [number, number] | null> = { commission_rate: [0, 100], deposit_percent: [0, 100], hold_minutes: [5, 1440], currency: null }, changed: DbRow = {};
    const statements: D1PreparedStatement[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (!(key in ranges)) throw new HttpError(`Unknown setting: ${key}`); const range = ranges[key];
      if (range && (!Number.isFinite(Number(value)) || Number(value) < range[0] || Number(value) > range[1])) throw new HttpError(`${key} out of range`);
      if (key === "currency" && !/^[A-Z]{3}$/.test(String(value))) throw new HttpError("currency must be a three-letter uppercase code");
      changed[key] = value; statements.push(env.DB.prepare("INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(key, String(value), timestamp));
    }
    if (statements.length) await env.DB.batch(statements); await audit(env, actor, "settings_update", "platform_settings", null, changed); return json({ ok: true, ...changed });
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
    for (const field of ["private_rate", "shared_rate"]) if (field in data) data[field] = numberField(data, field, { minimum: 0, maximum: 10_000_000 });
    if ("description" in data) data.description = textField(data, "description", 10_000);
    if ("image" in data) data.image = urlField(data, "image");
    for (const field of ["amenities", "experiences"]) if (field in data) data[field] = stringList(data, field);
    if ("gallery" in data) { const gallery = stringList(data, "gallery", 100); for (const value of gallery) { try { if (new URL(value).protocol !== "https:") throw new Error(); } catch { throw new HttpError("gallery must contain HTTPS URLs"); } } data.gallery = gallery; }
    const allowed = ["name", "type", "status", "private_enabled", "shared_enabled", "guests", "cabins", "crew", "length_m", "year_built", "year_refit", "description", "image", "private_rate", "shared_rate"];
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
    await env.DB.prepare("UPDATE departures SET title=?,start_date=?,end_date=?,nights=?,cabins_total=?,cabins_available=?,places_total=?,places_available=?,price_pp=?,status=? WHERE id=?").bind(merged.title, merged.start_date, merged.end_date, merged.nights, merged.cabins_total, merged.cabins_available, merged.places_total, merged.places_available, merged.price_pp, merged.status || "open", departureMatch[1]).run();
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

async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "GET") return await getApi(request, env, url);
    if (request.method === "POST") return await postApi(request, env, url);
    if (request.method === "PUT") return await putApi(request, env, url);
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: { ...JSON_HEADERS, allow: "GET, POST, PUT" } });
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    console.error(JSON.stringify({ level: "error", path: url.pathname, error: error instanceof Error ? error.stack : String(error) }));
    return json({ error: "Internal server error" }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return api(request, env);
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("x-content-type-options", "nosniff"); headers.set("x-frame-options", "DENY");
    headers.set("referrer-policy", "strict-origin-when-cross-origin"); headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    headers.set("content-security-policy", JSON_HEADERS["content-security-policy"]);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
} satisfies ExportedHandler<Env>;
