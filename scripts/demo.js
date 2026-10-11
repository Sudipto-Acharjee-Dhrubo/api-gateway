// Narrated demo for your viva / video. Needs gateway on :3000 and mocks on :4001/:4002
//   node src/server.js   |   node mock-upstream/server.js   |   node scripts/demo.js
const GW = process.env.GW || 'http://localhost:3000';
const MOCK = process.env.MOCK || 'http://localhost:4001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hit = async (path, key) => (await fetch(GW + path, { headers: { 'X-API-Key': key } }));

(async () => {
  console.log('\n1) Free client (bucket = 5, refill 1/s) fires 8 rapid requests:');
  let line = '';
  for (let i = 0; i < 8; i++) { const r = await hit('/users/1', 'demo-free-key-123'); line += r.status + ' '; }
  console.log('   ', line, '  <- 200s then 429s');
  const r = await hit('/users/1', 'demo-free-key-123');
  console.log('    Retry-After:', r.headers.get('retry-after'), 's | remaining:', r.headers.get('x-ratelimit-remaining'));

  console.log('\n2) Pro client is unaffected by the free client being throttled:');
  console.log('   ', (await hit('/users/1', 'demo-pro-key-456')).status);

  console.log('\n3) Break the users upstream (every request -> 500):');
  await fetch(MOCK + '/__fail/on');
  line = '';
  for (let i = 0; i < 8; i++) { const r = await hit('/users/1', 'demo-pro-key-456'); line += r.status + ' '; }
  console.log('   ', line, '  <- 500s until the circuit opens, then instant 503s');
  const open = await (await hit('/users/1', 'demo-pro-key-456')).json();
  console.log('    ', JSON.stringify(open));

  console.log('\n4) Heal the upstream, wait for the cool-down, probe request closes the circuit:');
  await fetch(MOCK + '/__fail/off');
  await sleep(Number(process.env.BREAKER_OPEN_MS || 10000) + 500);
  console.log('    probe ->', (await hit('/users/1', 'demo-pro-key-456')).status, '| next ->', (await hit('/users/1', 'demo-pro-key-456')).status);

  console.log('\n5) /health:', JSON.stringify(await (await fetch(GW + '/health')).json()));
  console.log('\nDone. Full metrics at', GW + '/metrics\n');
})();
