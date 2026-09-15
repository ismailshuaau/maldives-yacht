import assert from 'node:assert/strict';

const origin = process.env.ATOLLE_TEST_ORIGIN || 'http://127.0.0.1:8787';
async function call(path, options = {}) {
  const response = await fetch(origin + path, options);
  let data = {}; try { data = await response.json(); } catch {}
  return { response, data };
}

let result = await call('/api/yachts?status=draft');
assert.equal(result.response.status, 200);
assert.equal(result.data.length, 1, 'public catalogue should expose only the verified live fixture');

result = await call('/api/yachts/1/availability?start=not-a-date&end=also-bad');
assert.equal(result.response.status, 400);

const booking = { yacht_id: 1, mode: 'private', guests: 2, cabins_booked: 0, start_date: '2027-02-01', end_date: '2027-02-05', guest_name: 'Test Guest', email: 'guest@example.com' };
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

result = await call('/api/yachts/1/departures', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ title: 'Unsafe', start_date: '2027-03-01', end_date: '2027-03-03', nights: '<img src=x onerror=alert(1)>', cabins_total: 2, cabins_available: 2, places_total: 4, places_available: 4, price_pp: 100, status: 'open' }) });
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
