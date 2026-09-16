import assert from 'node:assert/strict';

const origin = (process.env.ATOLLE_STAGING_ORIGIN || 'https://maldivesliveaboardbooking.com').replace(/\/$/, '');
const email = process.env.STAGING_TEST_EMAIL;
const password = process.env.STAGING_TEST_PASSWORD;

assert.ok(email, 'STAGING_TEST_EMAIL is required');
assert.ok(password, 'STAGING_TEST_PASSWORD is required');

async function request(path, options = {}) {
  const response = await fetch(`${origin}${path}`, { redirect: 'follow', ...options });
  assert.equal(new URL(response.url).origin, new URL(origin).origin, `${path} redirected outside staging`);
  let data;
  try { data = await response.clone().json(); } catch { data = null; }
  return { response, data };
}

let result = await request('/api/health');
assert.equal(result.response.status, 200);
assert.equal(result.data?.ok, true);
assert.equal(result.data?.environment, 'staging');
assert.equal(result.data?.auth_enforced, true);
assert.deepEqual(
  result.data?.demo_accounts?.map(account => account.role).sort(),
  ['admin', 'vendor'],
  'staging health should expose the demo accounts',
);

const redirectPath = '/api/health?cutover=www&path=preserved';
const redirectResponse = await fetch(`https://www.maldivesliveaboardbooking.com${redirectPath}`, { redirect: 'manual' });
assert.equal(redirectResponse.status, 308, 'www should permanently redirect to the apex domain');
assert.equal(
  redirectResponse.headers.get('location'),
  `https://maldivesliveaboardbooking.com${redirectPath}`,
  'www redirect should preserve the path and query string',
);

for (const path of ['/', '/login.html', '/booking.html']) {
  result = await request(path);
  assert.equal(result.response.status, 200, `${path} should be available`);
  assert.match(result.response.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.match(result.response.headers.get('strict-transport-security') || '', /max-age=31536000/);
  assert.equal(result.response.headers.get('x-content-type-options'), 'nosniff');
}

for (const path of [
  '/assets/fonts/manrope-latin-variable.woff2',
  '/assets/fonts/cormorant-garamond-latin-600.woff2',
  '/assets/fonts/cormorant-garamond-latin-700.woff2',
]) {
  result = await request(path);
  assert.equal(result.response.status, 200, `${path} should be available`);
  assert.ok(Number(result.response.headers.get('content-length') || 1) > 0, `${path} should not be empty`);
}

result = await request('/api/yachts?status=draft');
assert.equal(result.response.status, 200);
assert.ok(Array.isArray(result.data) && result.data.length > 0, 'staging should expose a public catalogue');
assert.ok(result.data.every(yacht => yacht.status === 'live' && Number(yacht.verified) === 1), 'public catalogue must contain only verified live yachts');
const yachtId = result.data[0].id;

result = await request(`/api/yachts/${encodeURIComponent(yachtId)}/availability?start=not-a-date&end=also-bad`);
assert.equal(result.response.status, 400);

result = await request('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
assert.equal(result.response.status, 200, result.data?.error || 'staging login failed');
assert.equal(result.data?.token, undefined, 'session token must not be returned in JSON');
const cookie = result.response.headers.get('set-cookie');
assert.match(cookie || '', /atolle_session=/);
assert.match(cookie || '', /HttpOnly/i);
assert.match(cookie || '', /Secure/i);

result = await request('/api/auth/me', { headers: { Cookie: cookie } });
assert.equal(result.response.status, 200);
assert.equal(result.data?.email?.toLowerCase(), email.toLowerCase());
assert.equal(result.data?.password_hash, undefined);

result = await request('/api/auth/logout', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: '{}',
});
assert.equal(result.response.status, 200);

console.log(`Staging smoke checks passed for ${origin}.`);
