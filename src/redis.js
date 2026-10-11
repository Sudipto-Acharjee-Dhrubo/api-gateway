const Redis = require('ioredis');

// Token bucket, evaluated atomically inside Redis so concurrent gateway
// instances can never double-spend tokens.
//
// KEYS[1] = bucket key
// ARGV    = capacity, refillPerSec, cost
// Returns = { allowed(0/1), remainingTokens, retryAfterMs }
const TOKEN_BUCKET_LUA = `
local key      = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate     = tonumber(ARGV[2])
local cost     = tonumber(ARGV[3])

local t   = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)

local data   = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts     = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  ts = now
end

local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + (elapsed / 1000) * rate)

local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil(((cost - tokens) / rate) * 1000)
end

redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', now)
-- bucket is useless once it would be full again; let Redis clean it up
redis.call('PEXPIRE', key, math.ceil((capacity / rate) * 1000) + 1000)

return { allowed, math.floor(tokens), retry }
`;

function createRedis(url) {
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  client.on('error', (e) => console.error(JSON.stringify({ level: 'error', msg: 'redis', err: e.message })));
  client.defineCommand('tokenBucket', { numberOfKeys: 1, lua: TOKEN_BUCKET_LUA });
  return client;
}

// Resolves when connected, or after `ms` regardless (gateway still starts and
// follows the fail-open / fail-closed policy if Redis never shows up).
function waitReady(client, ms = 5000) {
  if (client.status === 'ready') return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    client.once('ready', () => { clearTimeout(timer); resolve(true); });
  });
}

module.exports = { createRedis, waitReady };
