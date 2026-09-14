const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
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
    if (!salt || !expected || !Number.isInteger(iterations) || iterations < 1 || iterations > 100_000) return false;
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

async function body(request: Request): Promise<DbRow> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 65_536) throw new HttpError("Request body too large", 413);
  try { return await request.json<DbRow>(); }
  catch { throw new HttpError("A valid JSON body is required", 400); }
}
class HttpError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

async function userFor(request: Request, env: Env): Promise<DbRow | null> {
  const header = request.headers.get("authorization") || "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  const tokenHash = await sha256(header.slice(7).trim());
  return row(await env.DB.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`).bind(tokenHash, now()).first<DbRow>());
}
async function requireRole(request: Request, env: Env, roles: string[]): Promise<DbRow> {
  const actor = await userFor(request, env);
  if (actor && roles.includes(String(actor.role))) return actor;
  throw new HttpError("Authentication required", 401);
}
async function issueSession(env: Env, userId: number): Promise<{ token: string; expires_at: string }> {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(36));
  const token = btoa(String.fromCharCode(...tokenBytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const expires = new Date(Date.now() + Number(env.SESSION_HOURS || 24) * 3_600_000).toISOString();
  await env.DB.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)")
    .bind(await sha256(token), userId, expires, now()).run();
  return { token, expires_at: expires };
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
  return typeof start === "string" && typeof end === "string" && /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) && end > start;
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
  const yacht = row(await env.DB.prepare("SELECT * FROM yachts WHERE id=?").bind(data.yacht_id).first<DbRow>());
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
  if (path === "/api/health") return json({ ok: true, time: now(), environment: env.ENVIRONMENT, auth_enforced: env.ENFORCE_AUTH === "1" });
  if (path === "/api/auth/me") {
    const actor = await userFor(request, env);
    if (!actor) return json({ authenticated: false }, 401);
    delete actor.password_hash;
    return json(actor);
  }
  if (path === "/api/yachts") {
    const clauses: string[] = [], values: unknown[] = [];
    for (const field of ["vendor_id", "status"]) if (url.searchParams.get(field)) { clauses.push(`${field}=?`); values.push(url.searchParams.get(field)); }
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
    const guests = Math.max(1, Number(url.searchParams.get("guests") || 1));
    const yachtType = (url.searchParams.get("type") || "").toLowerCase();
    const experience = (url.searchParams.get("experience") || "").toLowerCase();
    const durationMin = Math.max(0, Number(url.searchParams.get("duration_min") || 0));
    const durationMax = Math.max(0, Number(url.searchParams.get("duration_max") || 0));
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
    if (!start || !end) throw new HttpError("start and end are required");
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
    booking.payments = rows(await env.DB.prepare("SELECT * FROM payments WHERE booking_id=? ORDER BY id").bind(bookingMatch[1]).all<DbRow>());
    booking.refunds = rows(await env.DB.prepare("SELECT * FROM refunds WHERE booking_id=? ORDER BY id").bind(bookingMatch[1]).all<DbRow>());
    return json(booking);
  }
  if (path === "/api/payments") {
    const actor = await requireRole(request, env, ["vendor", "admin"]);
    let sql = "SELECT p.*,b.guest_name,y.name yacht_name,y.vendor_id FROM payments p JOIN bookings b ON b.id=p.booking_id JOIN yachts y ON y.id=b.yacht_id";
    const values: unknown[] = [];
    if (actor.role === "vendor") { sql += " WHERE y.vendor_id=?"; values.push(actor.vendor_id); }
    return json(rows(await env.DB.prepare(`${sql} ORDER BY p.id DESC`).bind(...values).all<DbRow>()));
  }
  const paymentMatch = path.match(/^\/api\/payments\/(\d+)$/);
  if (paymentMatch) {
    const payment = row(await env.DB.prepare("SELECT * FROM payments WHERE id=?").bind(paymentMatch[1]).first<DbRow>());
    if (payment) delete payment.raw_response;
    return payment ? json(payment) : json({ error: "Not found" }, 404);
  }
  if (path === "/api/payment/config") return json({ provider: "bml", mode: env.BML_MODE, environment: env.BML_ENV, currency: env.BML_CURRENCY, live_configured: false });
  if (path === "/api/admin/settings") {
    await requireRole(request, env, ["admin"]);
    const found = await env.DB.prepare("SELECT key,value FROM platform_settings").all<{ key: string; value: string }>();
    return json(Object.fromEntries(found.results.map((item) => [item.key, item.value])));
  }
  if (path === "/api/enquiries") {
    await requireRole(request, env, ["vendor", "admin"]);
    return json(rows(await env.DB.prepare("SELECT e.*,y.name yacht_name,y.vendor_id FROM enquiries e JOIN yachts y ON y.id=e.yacht_id ORDER BY e.id DESC").all<DbRow>()));
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
  const refunded = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) value FROM refunds WHERE booking_id=? AND status IN ('recorded','processed')").bind(bookingId).first<{ value: number }>();
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
    const email = String(data.email || "").trim().toLowerCase(), password = String(data.password || "");
    const found = row(await env.DB.prepare("SELECT * FROM users WHERE lower(email)=lower(?) AND active=1").bind(email).first<DbRow>());
    if (!found || !(await passwordMatches(password, String(found.password_hash)))) throw new HttpError("Invalid email or password", 401);
    const session = await issueSession(env, Number(found.id));
    await env.DB.prepare("UPDATE users SET last_login_at=? WHERE id=?").bind(timestamp, found.id).run();
    await audit(env, found, "login", "user", found.id);
    delete found.password_hash; return json({ ...session, user: found });
  }
  if (path === "/api/auth/logout") {
    const header = request.headers.get("authorization") || "";
    if (header.toLowerCase().startsWith("bearer ")) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(header.slice(7).trim())).run();
    return json({ ok: true });
  }
  if (path === "/api/bookings/quote") return json(quoteResponse(await bookingSelection(env, data)));
  if (path === "/api/bookings") {
    const selection = await bookingSelection(env, data);
    const { yacht, departureId, mode, guests, cabinsBooked, start, end, nights, total, depositPercent, deposit, currency } = selection;
    const refBytes = crypto.getRandomValues(new Uint8Array(3));
    const ref = `ATL-${timestamp.slice(2, 10).replaceAll("-", "")}-${hex(refBytes.buffer).toUpperCase()}`;
    const expires = new Date(Date.now() + Number(await setting(env, "hold_minutes", "30")) * 60_000).toISOString();
    const insert = await env.DB.prepare(`INSERT INTO bookings(booking_ref,yacht_id,departure_id,mode,guest_name,email,phone,guests,cabins_booked,start_date,end_date,nights,total_amount,deposit_percent,deposit_amount,amount_paid,balance_due,currency,status,payment_status,notes,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?, 'pending_operator','unpaid',?,?,?,?)`).bind(ref, yacht.id, departureId, mode, data.guest_name, data.email, data.phone || null, guests, cabinsBooked, start, end, nights, total, depositPercent, deposit, total, currency, data.notes || null, expires, timestamp, timestamp).run();
    const bookingId = insert.meta.last_row_id;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO availability_holds(booking_id,yacht_id,departure_id,start_date,end_date,units,cabin_units,expires_at,status,created_at) VALUES(?,?,?,?,?,?,?,?, 'active',?)").bind(bookingId, yacht.id, departureId, start, end, mode === "shared" ? guests : 1, cabinsBooked, expires, timestamp),
      env.DB.prepare("INSERT INTO notifications(vendor_id,booking_id,channel,subject,body,status,created_at) VALUES(?,?, 'in_app','New booking request',?, 'queued',?)").bind(yacht.vendor_id, bookingId, `New ${mode} booking request ${ref} for ${yacht.name}.`, timestamp)
    ]);
    await audit(env, await userFor(request, env), "create", "booking", bookingId, { ref, total });
    return json({ id: bookingId, booking_ref: ref, status: "pending_operator", total_amount: total, deposit_percent: depositPercent, deposit_amount: deposit, balance_due: total, currency, hold_expires_at: expires }, 201);
  }
  if (path === "/api/payments/create") {
    const booking = row(await env.DB.prepare("SELECT * FROM bookings WHERE id=?").bind(data.booking_id).first<DbRow>());
    if (!booking) throw new HttpError("Booking not found", 404);
    if (["declined", "cancelled", "completed"].includes(String(booking.status))) throw new HttpError("Booking is not payable", 409);
    await syncBooking(env, booking.id);
    const current = row(await env.DB.prepare("SELECT * FROM bookings WHERE id=?").bind(booking.id).first<DbRow>()) as DbRow;
    const type = ["deposit", "balance", "full"].includes(String(data.payment_type)) ? String(data.payment_type) : Number(current.deposit_amount) < Number(current.total_amount) ? "deposit" : "full";
    const amount = type === "deposit" ? round(Math.max(0, Number(current.deposit_amount) - Number(current.amount_paid))) : round(Number(current.balance_due));
    if (amount <= 0) throw new HttpError("No payment is currently due", 409);
    const rate = Math.max(0, Math.min(100, Number(await setting(env, "commission_rate", "30")))), commission = round(amount * rate / 100), net = round(amount - commission);
    const insert = await env.DB.prepare(`INSERT INTO payments(booking_id,provider,payment_type,amount,currency,commission_rate,commission_amount,operator_net_amount,payout_status,status,created_at,updated_at)
      VALUES(?,'bml',?,?,?,?,?,?,'pending','created',?,?)`).bind(booking.id, type, amount, booking.currency, rate, commission, net, timestamp, timestamp).run();
    const paymentId = insert.meta.last_row_id;
    const bytes = crypto.getRandomValues(new Uint8Array(16)), demoToken = hex(bytes.buffer);
    const providerRef = `BML-DEMO-${demoToken.slice(0, 10).toUpperCase()}`, checkout = `/payment-return.html?payment_id=${paymentId}&demo=1&demo_token=${demoToken}`;
    await env.DB.prepare("UPDATE payments SET provider_reference=?,checkout_url=?,status='pending',raw_response=?,updated_at=? WHERE id=?").bind(providerRef, checkout, JSON.stringify({ mode: "mock", reference: providerRef, demo_token_hash: await sha256(demoToken) }), now(), paymentId).run();
    await audit(env, await userFor(request, env), "create", "payment", paymentId, { amount, commission_rate: rate });
    return json({ payment_id: paymentId, checkout_url: checkout, provider_reference: providerRef, status: "pending", gross_amount: amount, commission_rate: rate, commission_amount: commission, operator_net_amount: net }, 201);
  }
  if (path === "/api/payments/demo-complete") {
    const payment = row(await env.DB.prepare("SELECT raw_response FROM payments WHERE id=?").bind(data.payment_id).first<DbRow>());
    const expected = String((payment?.raw_response as DbRow | undefined)?.demo_token_hash || ""), supplied = await sha256(String(data.demo_token || ""));
    if (!expected || !constantEqual(expected, supplied)) throw new HttpError("Invalid payment return token", 403);
    const status = ["paid", "failed", "cancelled"].includes(String(data.status)) ? String(data.status) : "paid";
    if (!(await markPayment(env, data.payment_id, status, await userFor(request, env)))) throw new HttpError("Payment not found", 404);
    return json({ ok: true, status });
  }
  if (path === "/api/enquiries") {
    const insert = await env.DB.prepare("INSERT INTO enquiries(yacht_id,guest_name,email,guests,experience,message,status,created_at) VALUES(?,?,?,?,?,?, 'new',?)").bind(data.yacht_id, data.guest_name, data.email, data.guests || null, data.experience || null, data.message || null, timestamp).run();
    return json({ id: insert.meta.last_row_id }, 201);
  }
  if (path === "/api/yachts") {
    const actor = await requireRole(request, env, ["vendor", "admin"]), vendorId = actor.vendor_id || data.vendor_id;
    if (!vendorId) throw new HttpError("vendor_id required");
    const privateEnabled = bool(data.private_enabled), sharedEnabled = bool(data.shared_enabled);
    if (!privateEnabled && !sharedEnabled) throw new HttpError("At least one booking model must be enabled");
    const slug = String(data.name || "yacht").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const insert = await env.DB.prepare(`INSERT INTO yachts(vendor_id,name,slug,type,status,private_enabled,shared_enabled,guests,cabins,crew,length_m,year_built,year_refit,description,image,private_rate,shared_rate,amenities_json,experiences_json,gallery_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(vendorId, data.name, slug, data.type, data.status || "draft", Number(privateEnabled), Number(sharedEnabled), data.guests, data.cabins, data.crew, data.length_m, data.year_built, data.year_refit, data.description, data.image, data.private_rate, data.shared_rate, JSON.stringify(data.amenities || []), JSON.stringify(data.experiences || []), JSON.stringify(data.gallery || []), timestamp).run();
    await audit(env, actor, "create", "yacht", insert.meta.last_row_id, { name: data.name }); return json({ id: insert.meta.last_row_id }, 201);
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
    const insert = await env.DB.prepare("INSERT INTO vendor_documents(vendor_id,yacht_id,document_type,reference,file_url,status,note,uploaded_at) VALUES(?,?,?,?,?,'pending',?,?)").bind(vendorId, data.yacht_id || null, data.document_type, data.reference || null, data.file_url || null, data.note || null, timestamp).run();
    await audit(env, actor, "upload_metadata", "vendor_document", insert.meta.last_row_id, { document_type: data.document_type }); return json({ id: insert.meta.last_row_id, status: "pending" }, 201);
  }
  if (path === "/api/refunds") {
    const actor = await requireRole(request, env, ["admin"]), payment = await env.DB.prepare("SELECT * FROM payments WHERE id=? AND status='paid'").bind(data.payment_id).first<DbRow>();
    if (!payment) throw new HttpError("A paid payment is required");
    const prior = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) value FROM refunds WHERE payment_id=? AND status IN ('recorded','processed')").bind(payment.id).first<{ value: number }>();
    const amount = round(Number(data.amount || 0));
    if (amount <= 0 || Number(prior?.value || 0) + amount > Number(payment.amount) + .001) throw new HttpError("Invalid refund amount");
    const ratio = amount / Number(payment.amount), commission = round(Number(payment.commission_amount) * ratio), operator = round(Number(payment.operator_net_amount) * ratio);
    const insert = await env.DB.prepare("INSERT INTO refunds(payment_id,booking_id,amount,commission_reversal,operator_reversal,reason,status,created_at) VALUES(?,?,?,?,?,?,'recorded',?)").bind(payment.id, payment.booking_id, amount, commission, operator, data.reason || null, timestamp).run();
    await syncBooking(env, payment.booking_id); await audit(env, actor, "refund_recorded", "refund", insert.meta.last_row_id, { amount }); return json({ id: insert.meta.last_row_id, amount, commission_reversal: commission, operator_reversal: operator, status: "recorded" }, 201);
  }
  if (path === "/api/admin/payouts") {
    const actor = await requireRole(request, env, ["admin"]), amount = round(Number(data.amount || 0)); if (amount <= 0) throw new HttpError("amount must be positive");
    const insert = await env.DB.prepare("INSERT INTO payouts(vendor_id,amount,currency,status,reference,notes,created_at) VALUES(?,?,?,'pending',?,?,?)").bind(data.vendor_id, amount, data.currency || "USD", data.reference || null, data.notes || null, timestamp).run();
    await audit(env, actor, "payout_created", "payout", insert.meta.last_row_id, { amount }); return json({ id: insert.meta.last_row_id, status: "pending" }, 201);
  }
  throw new HttpError("Unknown endpoint", 404);
}

function validateDeparture(data: DbRow): void {
  if (!validDates(data.start_date, data.end_date)) throw new HttpError("End date must follow start date");
  for (const key of ["nights", "cabins_total", "cabins_available", "places_total", "places_available", "price_pp"]) if (Number(data[key]) < 0) throw new HttpError("Duration, inventory, and price must be non-negative");
  if (Number(data.cabins_available) > Number(data.cabins_total)) throw new HttpError("Available cabins cannot exceed total cabins");
  if (Number(data.places_available) > Number(data.places_total)) throw new HttpError("Available places cannot exceed total places");
}

async function putApi(request: Request, env: Env, url: URL): Promise<Response> {
  const data = await body(request), path = url.pathname, timestamp = now();
  if (path === "/api/admin/settings") {
    const actor = await requireRole(request, env, ["admin"]), ranges: Record<string, [number, number] | null> = { commission_rate: [0, 100], deposit_percent: [0, 100], hold_minutes: [5, 1440], currency: null }, changed: DbRow = {};
    const statements: D1PreparedStatement[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (!(key in ranges)) continue; const range = ranges[key];
      if (range && (!Number.isFinite(Number(value)) || Number(value) < range[0] || Number(value) > range[1])) throw new HttpError(`${key} out of range`);
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
    const values = action === "vendor_verification" ? [Number(bool(data.verified)), data.status || (bool(data.verified) ? "verified" : "pending"), timestamp, match[1]]
      : action === "document_review" ? [data.status || "approved", data.note || null, timestamp, actor.id, match[1]]
      : action === "payout_status" ? [data.status || "paid", data.reference || null, (data.status || "paid") === "paid" ? timestamp : null, match[1]]
      : [Number(bool(data.verified)), data.verification_note || null, data.status || null, timestamp, match[1]];
    await env.DB.prepare(sql).bind(...values).run(); await audit(env, actor, action, action.split("_")[0], match[1], data); return json({ ok: true });
  }
  const yachtMatch = path.match(/^\/api\/yachts\/(\d+)$/);
  if (yachtMatch) {
    const actor = await requireRole(request, env, ["vendor", "admin"]), yacht = row(await env.DB.prepare("SELECT * FROM yachts WHERE id=?").bind(yachtMatch[1]).first<DbRow>());
    if (!yacht) throw new HttpError("Not found", 404); if (actor.role === "vendor" && yacht.vendor_id !== actor.vendor_id) throw new HttpError("Forbidden", 403);
    const privateEnabled = "private_enabled" in data ? bool(data.private_enabled) : bool(yacht.private_enabled), sharedEnabled = "shared_enabled" in data ? bool(data.shared_enabled) : bool(yacht.shared_enabled);
    if (!privateEnabled && !sharedEnabled) throw new HttpError("At least one booking model must be enabled");
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
    await env.DB.prepare("UPDATE departures SET title=?,start_date=?,end_date=?,nights=?,cabins_total=?,cabins_available=?,places_total=?,places_available=?,price_pp=?,status=? WHERE id=?").bind(merged.title, merged.start_date, merged.end_date, merged.nights, merged.cabins_total, merged.cabins_available, merged.places_total, merged.places_available, merged.price_pp, merged.status || "open", departureMatch[1]).run();
    await audit(env, actor, "update", "departure", departureMatch[1], { fields: Object.keys(data) }); return json({ ok: true });
  }
  const bookingMatch = path.match(/^\/api\/bookings\/(\d+)$/);
  if (bookingMatch) {
    const actor = await requireRole(request, env, ["vendor", "admin"]), booking = await env.DB.prepare("SELECT b.*,y.vendor_id FROM bookings b JOIN yachts y ON y.id=b.yacht_id WHERE b.id=?").bind(bookingMatch[1]).first<DbRow>();
    if (!booking) throw new HttpError("Not found", 404); if (actor.role === "vendor" && booking.vendor_id !== actor.vendor_id) throw new HttpError("Forbidden", 403);
    const status = String(data.status || ""); if (!["approved", "declined", "cancelled", "confirmed", "completed", "awaiting_payment"].includes(status)) throw new HttpError("Invalid booking status");
    await env.DB.prepare("UPDATE bookings SET status=?,updated_at=? WHERE id=?").bind(status, timestamp, bookingMatch[1]).run();
    if (["declined", "cancelled", "completed"].includes(status)) await env.DB.prepare("UPDATE availability_holds SET status='released' WHERE booking_id=?").bind(bookingMatch[1]).run();
    await audit(env, actor, "booking_status", "booking", bookingMatch[1], { status }); return json({ ok: true, status });
  }
  throw new HttpError("Unknown endpoint", 404);
}

async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "GET") return await getApi(request, env, url);
    if (request.method === "POST") return await postApi(request, env, url);
    if (request.method === "PUT") return await putApi(request, env, url);
    return json({ error: "Method not allowed" }, 405);
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
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
} satisfies ExportedHandler<Env>;
