// Integration tests. Requires a Redis at REDIS_URL (default redis://127.0.0.1:6379).
const test = require('node:test');
const assert = require('node:assert');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { createMock } = require('../mock-upstream/server');

const FREE = { 'X-API-Key': 'demo-free-key-123' };
const PRO = { 'X-API-Key': 'demo-pro-key-456' };
const JSON_HDR = { 'content-type': 'application/json' };

let gw, mock, base, mockBase;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  mock = createMock({ name: 'users', port: 4101 });
  await mock.listen();
  mockBase = 'http://127.0.0.1:4101';
  const config = loadConfig({
    routes: [{ prefix: '/users', target: mockBase }],
    breaker: { failureThreshold: 3, openMs: 600 },
    proxyTimeoutMs: 800,
  });
  gw = createApp(config);
  await gw.ready();
  await gw.redis.flushdb();
  await new Promise((r) => { gw.server = gw.app.listen(0, r); });
  base = `http://127.0.0.1:${gw.server.address().port}`;
});

test.after(async () => {
  gw.server.closeAllConnections?.();
  gw.server.close();
  await gw.close();
  mock.server.closeAllConnections?.();
  await mock.close();
});

const get = (path, headers = {}) => fetch(base + path, { headers });

test('rejects missing / bad credentials with 401', async () => {
  assert.strictEqual((await get('/users/1')).status, 401);
  assert.strictEqual((await get('/users/1', { 'X-API-Key': 'nope' })).status, 401);
  assert.strictEqual((await get('/users/1', { Authorization: 'Bearer garbage' })).status, 401);
});

test('proxies with API key, strips prefix and credentials, adds client identity', async () => {
  const r = await get('/users/42?a=1', PRO);
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.strictEqual(body.path, '/42?a=1');
  assert.strictEqual(body.receivedHeaders['x-client-id'], 'bob');
  assert.strictEqual(body.receivedHeaders['x-api-key'], undefined);
  assert.strictEqual(body.receivedHeaders.authorization, undefined);
});

test('JWT flow: issue token then use it', async () => {
  const t = await fetch(base + '/auth/token', { method: 'POST', headers: JSON_HDR,
    body: JSON.stringify({ apiKey: 'demo-pro-key-456' }) });
  assert.strictEqual(t.status, 200);
  const { token } = await t.json();
  const r = await get('/users/1', { Authorization: `Bearer ${token}` });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).receivedHeaders['x-client-plan'], 'pro');

  const bad = await fetch(base + '/auth/token', { method: 'POST', headers: JSON_HDR,
    body: JSON.stringify({ apiKey: 'wrong' }) });
  assert.strictEqual(bad.status, 401);
});

test('token bucket: burst up to capacity, then 429 with Retry-After, then refills', async () => {
  await gw.redis.flushdb();
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await get('/users/1', FREE)).status);
  assert.deepStrictEqual(codes, [200, 200, 200, 200, 200, 429, 429]);

  const limited = await get('/users/1', FREE);
  assert.strictEqual(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.strictEqual(limited.headers.get('x-ratelimit-remaining'), '0');

  await sleep(1200);   // free plan refills 1 token/sec
  assert.strictEqual((await get('/users/1', FREE)).status, 200);
});

test('limits are per client: alice being throttled does not affect bob', async () => {
  await gw.redis.flushdb();
  for (let i = 0; i < 6; i++) await get('/users/1', FREE);
  assert.strictEqual((await get('/users/1', FREE)).status, 429);
  assert.strictEqual((await get('/users/1', PRO)).status, 200);
});

test('concurrent requests cannot overspend the bucket (atomicity)', async () => {
  await gw.redis.flushdb();
  const results = await Promise.all(Array.from({ length: 30 }, () => get('/users/1', FREE)));
  const ok = results.filter((r) => r.status === 200).length;
  assert.ok(ok >= 5 && ok <= 6, `expected 5 (maybe 6 with a refill), got ${ok}`);
});

test('daily quota is enforced', async () => {
  await gw.redis.flushdb();
  const day = new Date().toISOString().slice(0, 10);
  await gw.redis.set(`rl:quota:bob:${day}`, 100000);   // bob is at his cap
  const r = await get('/users/1', PRO);
  assert.strictEqual(r.status, 429);
  assert.strictEqual((await r.json()).error, 'quota_exceeded');
});

test('circuit breaker: trips on 5xx, fails fast, then recovers via probe', async () => {
  await gw.redis.flushdb();
  await fetch(mockBase + '/__fail/on');
  const hitsBefore = (await (await fetch(mockBase + '/__hits')).json()).hits;

  for (let i = 0; i < 3; i++) assert.strictEqual((await get('/users/1', PRO)).status, 500);
  assert.strictEqual(gw.breakers[0].state, 'OPEN');

  // OPEN: rejected instantly without touching the upstream
  const fast = await get('/users/1', PRO);
  assert.strictEqual(fast.status, 503);
  assert.strictEqual((await fast.json()).error, 'circuit_open');
  const hitsAfter = (await (await fetch(mockBase + '/__hits')).json()).hits;
  assert.strictEqual(hitsAfter - hitsBefore, 3, 'open circuit must not forward requests');

  // upstream heals, cooldown passes, probe succeeds -> CLOSED
  await fetch(mockBase + '/__fail/off');
  await sleep(700);
  assert.strictEqual((await get('/users/1', PRO)).status, 200);
  assert.strictEqual(gw.breakers[0].state, 'CLOSED');
});

test('upstream timeout returns 504/502', async () => {
  await gw.redis.flushdb();
  gw.breakers[0].recordSuccess();
  const r = await get('/users/slow?ms=2000', PRO);
  assert.ok([504, 502].includes(r.status), `got ${r.status}`);
});

test('metrics endpoint exposes counters', async () => {
  const text = await (await get('/metrics')).text();
  assert.match(text, /gateway_requests_total\{route="\/users",status="200"\}/);
  assert.match(text, /gateway_throttled_total\{client="alice"\}/);
  assert.match(text, /gateway_circuit_trips_total/);
});

test('fails open when Redis is unavailable (configurable)', async () => {
  const cfg = loadConfig({ routes: [{ prefix: '/users', target: mockBase }], redisUrl: 'redis://127.0.0.1:6399' });
  const dead = createApp(cfg);
  await new Promise((r) => { dead.server = dead.app.listen(0, r); });
  const url = `http://127.0.0.1:${dead.server.address().port}/users/1`;
  const r = await fetch(url, { headers: PRO });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('x-ratelimit-status'), 'degraded');
  dead.server.closeAllConnections?.();
  dead.server.close(); dead.redis.disconnect();
});
