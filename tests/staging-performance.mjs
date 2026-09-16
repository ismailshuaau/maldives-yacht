import assert from 'node:assert/strict';

const origin = (process.env.ATOLLE_STAGING_ORIGIN || 'https://maldivesliveaboardbooking.com').replace(/\/$/, '');
const start = process.env.ATOLLE_PERF_START || '2028-04-01';
const end = process.env.ATOLLE_PERF_END || '2028-04-30';

async function timed(path) {
  const began = performance.now();
  const response = await fetch(origin + path);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const duration = performance.now() - began;
  let data;
  try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { data = null; }
  return { response, data, bytes: bytes.byteLength, duration };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Establish DNS/TLS before measuring the application search path.
const health = await fetch(origin + '/api/health');
assert.equal(health.status, 200);

for (const mode of ['shared', 'private']) {
  const probe = crypto.randomUUID();
  const path = `/api/search?mode=${mode}&start=${start}&end=${end}&guests=2&probe=${probe}`;
  const cold = await timed(path);
  assert.equal(cold.response.status, 200, JSON.stringify(cold.data));
  assert.equal(cold.response.headers.get('x-atolle-cache'), 'MISS');
  assert.ok(cold.duration < 3_000, `${mode} uncached search took ${cold.duration.toFixed(0)}ms`);
  assert.ok(cold.bytes < 60_000, `${mode} payload was ${cold.bytes} bytes`);
  assert.ok(Array.isArray(cold.data?.items));
  assert.equal(new Set(cold.data.items.map(item => item.id)).size, cold.data.items.length);
  if (cold.data.total >= 12) assert.equal(cold.data.items.length, 12, `${mode} full page must contain 12 yachts`);

  const warmDurations = [];
  for (let attempt = 0; attempt < 10 && warmDurations.length < 5; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 50));
    const warm = await timed(path);
    assert.equal(warm.response.status, 200);
    if (warm.response.headers.get('x-atolle-cache') === 'HIT') warmDurations.push(warm.duration);
  }
  assert.equal(warmDurations.length, 5, `${mode} did not produce five cache hits`);
  assert.ok(median(warmDurations) < 750, `${mode} cached median was ${median(warmDurations).toFixed(0)}ms`);
  console.log(JSON.stringify({ mode, uncached_ms: Math.round(cold.duration), cached_median_ms: Math.round(median(warmDurations)), payload_bytes: cold.bytes, returned: cold.data.items.length, total: cold.data.total }));
}
