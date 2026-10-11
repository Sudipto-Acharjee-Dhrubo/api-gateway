const fs = require('fs');
const path = require('path');

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', file), 'utf8'));
}

// Upstream targets can be overridden with env vars, e.g. UPSTREAM_USERS=https://my-service.onrender.com
function loadRoutes() {
  return readJson('routes.json').map((r) => {
    const envKey = 'UPSTREAM_' + r.prefix.replace(/\W/g, '').toUpperCase();
    return { ...r, target: process.env[envKey] || r.target };
  });
}

function loadConfig(overrides = {}) {
  const clientsFile = readJson('clients.json');
  return {
    port: Number(process.env.PORT) || 3000,
    redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    jwtSecret: process.env.JWT_SECRET || 'dev-only-change-me',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',
    // If Redis is down: true = let traffic through, false = reject with 503
    rateLimitFailOpen: process.env.RATE_LIMIT_FAIL_OPEN !== 'false',
    routes: loadRoutes(),
    plans: clientsFile.plans,
    clients: clientsFile.clients,
    breaker: {
      failureThreshold: Number(process.env.BREAKER_FAILURES) || 5,
      openMs: Number(process.env.BREAKER_OPEN_MS) || 10000,
    },
    proxyTimeoutMs: Number(process.env.PROXY_TIMEOUT_MS) || 10000,
    ...overrides,
  };
}

module.exports = { loadConfig };
