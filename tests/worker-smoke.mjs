import assert from 'node:assert/strict';

const origin = process.env.ATOLLE_TEST_ORIGIN || 'http://127.0.0.1:8787';
const isoDate = daysFromNow => new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
async function call(path, options = {}) {
  const response = await fetch(origin + path, options);
  let data = {}; try { data = await response.json(); } catch {}
  return { response, data };
}

let result = await call('/api/yachts?status=draft');
assert.equal(result.response.status, 200);
assert.equal(result.data.length, 15, 'public catalogue should expose only verified live fixtures');

result = await call('/api/search/options');
assert.equal(result.response.status, 200);
assert.deepEqual(result.data.types, ['Liveaboard', 'Motor Yacht']);

const searchDates = `start=${isoDate(80)}&end=${isoDate(110)}`;
result = await call(`/api/search?mode=shared&${searchDates}&guests=2`);
assert.equal(result.response.status, 200, JSON.stringify(result.data));
assert.equal(result.response.headers.get('x-atolle-cache'), 'MISS');
assert.match(result.response.headers.get('server-timing') || '', /db;dur=/);
assert.equal(result.data.total, 15);
assert.equal(result.data.items.length, 12);
assert.ok(result.data.next_cursor);
assert.equal(new Set(result.data.items.map(item => item.id)).size, 12);
assert.ok(result.data.items.every(item => item.matching_departures.length === 1));
assert.ok(result.data.items.some(item => item.id === 1), 'an expired hold must not hide its departure');

const firstPageIds = new Set(result.data.items.map(item => item.id));
const secondPage = await call(`/api/search?mode=shared&${searchDates}&guests=2&cursor=${encodeURIComponent(result.data.next_cursor)}`);
assert.equal(secondPage.response.status, 200, JSON.stringify(secondPage.data));
assert.equal(secondPage.data.items.length, 3);
assert.equal(secondPage.data.next_cursor, null);
assert.ok(secondPage.data.items.every(item => !firstPageIds.has(item.id)), 'cursor pages must not contain duplicates');

result = await call(`/api/search?mode=private&${searchDates}&guests=4&type=Motor%20Yacht&experience=Diving`);
assert.equal(result.response.status, 200);
assert.equal(result.data.total, 7);
assert.ok(result.data.items.every(item => item.type === 'Motor Yacht'));

result = await call(`/api/search?mode=shared&${searchDates}&guests=2&duration_min=6`);
assert.equal(result.response.status, 200);
assert.equal(result.data.total, 0);
assert.deepEqual(result.data.items, []);

assert.equal((await call(`/api/search?mode=shared&${searchDates}&cursor=broken`)).response.status, 400);

const cachePath = `/api/search?mode=shared&${searchDates}&guests=3&experience=Luxury%20escape`;
const cacheMiss = await call(cachePath);
assert.equal(cacheMiss.response.headers.get('x-atolle-cache'), 'MISS');
let cacheHit;
for (let attempt = 0; attempt < 10; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 25));
  cacheHit = await call(cachePath);
  if (cacheHit.response.headers.get('x-atolle-cache') === 'HIT') break;
}
assert.equal(cacheHit.response.headers.get('x-atolle-cache'), 'HIT');
result = await call(cachePath, { headers: { Cookie: 'authenticated=1' } });
assert.equal(result.response.headers.get('x-atolle-cache'), 'BYPASS');
assert.match(result.response.headers.get('cache-control') || '', /no-store/);

result = await call('/api/yachts/1/availability?start=not-a-date&end=also-bad');
assert.equal(result.response.status, 400);

const booking = { yacht_id: 1, mode: 'private', guests: 2, cabins_booked: 0, start_date: isoDate(120), end_date: isoDate(124), guest_name: 'Test Guest', email: 'guest@example.com' };
result = await call('/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(booking) });
assert.equal(result.response.status, 400, 'booking must require idempotency');

const bookingKey = crypto.randomUUID();
result = await call('/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': bookingKey }, body: JSON.stringify(booking) });
assert.equal(result.response.status, 201, JSON.stringify(result.data));
assert.equal(result.data.booking_token, bookingKey);
const bookingId = result.data.id;

const duplicate = await call('/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': bookingKey }, body: JSON.stringify(booking) });
assert.equal(duplicate.response.status, 200);
assert.equal(duplicate.data.id, bookingId);

const competing = await call('/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ ...booking, email: 'other@example.com' }) });
assert.equal(competing.response.status, 409, JSON.stringify(competing.data));

result = await call('/api/payments/create', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ booking_id: bookingId, payment_type: 'deposit' }) });
assert.equal(result.response.status, 404, 'payment creation must require booking ownership');

const paymentKey = crypto.randomUUID();
result = await call('/api/payments/create', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': paymentKey, 'X-Booking-Token': bookingKey }, body: JSON.stringify({ booking_id: bookingId, payment_type: 'deposit' }) });
assert.equal(result.response.status, 201, JSON.stringify(result.data));
const paymentId = result.data.payment_id;
assert.ok(!result.data.checkout_url.includes('booking_token'));

assert.equal((await call(`/api/payments/${paymentId}`)).response.status, 404);
assert.equal((await call(`/api/payments/${paymentId}`, { headers: { 'X-Payment-Token': paymentKey } })).response.status, 200);

result = await call('/api/payments/demo-complete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Payment-Token': paymentKey }, body: JSON.stringify({ payment_id: paymentId, status: 'paid' }) });
assert.equal(result.response.status, 200);
assert.equal(result.data.status, 'paid');

const login = await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'operator@example.com', password: 'AtolleVendor123!' }) });
assert.equal(login.response.status, 200, JSON.stringify(login.data));
assert.equal(login.data.token, undefined, 'bearer token must not be exposed to JavaScript');
const cookie = login.response.headers.get('set-cookie');
assert.match(cookie || '', /HttpOnly/);

result = await call('/api/enquiries', { headers: { Cookie: cookie } });
assert.equal(result.response.status, 200);
assert.equal(result.data.length, 1, 'vendor must only see enquiries for its own yachts');

result = await call('/api/yachts/1/departures', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ title: 'Unsafe', start_date: isoDate(150), end_date: isoDate(152), nights: '<img src=x onerror=alert(1)>', cabins_total: 2, cabins_available: 2, places_total: 4, places_available: 4, price_pp: 100, status: 'open' }) });
assert.equal(result.response.status, 400, 'non-numeric inventory must be rejected');

result = await call(`/api/payments/${paymentId}/reconcile`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
assert.equal(result.response.status, 200, JSON.stringify(result.data));

const adminLogin = await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@atolle.mv', password: 'AtolleAdmin123!' }) });
assert.equal(adminLogin.response.status, 200, JSON.stringify(adminLogin.data));
const adminCookie = adminLogin.response.headers.get('set-cookie');
const payoutKey = crypto.randomUUID();
result = await call('/api/admin/payouts', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie, 'Idempotency-Key': payoutKey }, body: JSON.stringify({ vendor_id: 1, amount: 100, currency: 'USD' }) });
assert.equal(result.response.status, 201, JSON.stringify(result.data));
const payoutId = result.data.id;
result = await call('/api/admin/payouts', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie, 'Idempotency-Key': payoutKey }, body: JSON.stringify({ vendor_id: 1, amount: 100, currency: 'USD' }) });
assert.equal(result.response.status, 200);
assert.equal(result.data.id, payoutId);
result = await call('/api/admin/payouts', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ vendor_id: 1, amount: 10000000, currency: 'USD' }) });
assert.equal(result.response.status, 409);

console.log('Worker security smoke checks passed.');
