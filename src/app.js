const crypto = require('crypto');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createRedis, waitReady } = require('./redis');
const { createAuth, issueToken } = require('./middleware/auth');
const { createRateLimiter } = require('./middleware/rateLimit');
const { CircuitBreaker } = require('./circuitBreaker');
const { Metrics } = require('./metrics');

function createApp(config) {
  const app = express();
  app.disable('x-powered-by');

  const redis = createRedis(config.redisUrl);
  const metrics = new Metrics();
  const auth = createAuth(config);
  const rateLimit = createRateLimiter(config, redis, metrics);
  const breakers = config.routes.map((r) => new CircuitBreaker(r.prefix, config.breaker));

  // ---- request id + structured access log + latency metrics (all requests) ----
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    req.id = req.get('x-request-id') || crypto.randomUUID();
    res.set('X-Request-Id', req.id);
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const route = res.locals.route || 'other';
      metrics.observe(route, res.statusCode, ms);
      console.log(JSON.stringify({
        level: 'info', id: req.id, method: req.method, path: req.originalUrl,
        route, status: res.statusCode, ms: Number(ms.toFixed(1)),
        client: req.client ? req.client.id : null,
      }));
    });
    next();
  });

  // ---- gateway's own endpoints ----
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      redis: redis.status,
      circuits: Object.fromEntries(breakers.map((b) => [b.name, b.state])),
    });
  });

  app.get('/metrics', (req, res) => {
    res.type('text/plain; version=0.0.4').send(metrics.render(breakers));
  });

  app.post('/auth/token', express.json({ limit: '1kb' }), (req, res) => {
    const result = issueToken(config, req.body && req.body.apiKey);
    if (!result) return res.status(401).json({ error: 'invalid_api_key' });
    res.json(result);
  });

  // ---- proxied routes: auth -> rate limit -> circuit breaker -> proxy ----
  config.routes.forEach((route, i) => {
    const breaker = breakers[i];

    const tag = (req, res, next) => { res.locals.route = route.prefix; next(); };

    const guard = (req, res, next) => {
      if (breaker.allow()) return next();
      res.set('Retry-After', String(breaker.retryAfterSec()));
      return res.status(503).json({ error: 'circuit_open', upstream: route.prefix });
    };

    const record = (ok) => {
      const before = breaker.state;
      ok ? breaker.recordSuccess() : breaker.recordFailure();
      if (before !== 'OPEN' && breaker.state === 'OPEN') {
        metrics.trip(route.prefix);
        console.log(JSON.stringify({ level: 'warn', msg: 'circuit opened', upstream: route.prefix }));
      } else if (before !== 'CLOSED' && breaker.state === 'CLOSED') {
        console.log(JSON.stringify({ level: 'info', msg: 'circuit closed (upstream recovered)', upstream: route.prefix }));
      }
    };

    const proxy = createProxyMiddleware({
      target: route.target,
      changeOrigin: true,
      proxyTimeout: config.proxyTimeoutMs,
      on: {
        proxyReq: (proxyReq, req) => {
          // never leak the caller's credentials to upstream services
          proxyReq.removeHeader('x-api-key');
          proxyReq.removeHeader('authorization');
          proxyReq.setHeader('x-request-id', req.id);
          proxyReq.setHeader('x-client-id', req.client.id);
          proxyReq.setHeader('x-client-plan', req.client.plan);
        },
        proxyRes: (proxyRes) => record(proxyRes.statusCode < 500),
        error: (err, req, res) => {
          record(false);
          if (res.headersSent || typeof res.status !== 'function') return;
          const timeout = err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
          res.status(timeout ? 504 : 502).json({
            error: timeout ? 'upstream_timeout' : 'upstream_unavailable',
            upstream: route.prefix,
          });
        },
      },
    });

    app.use(route.prefix, tag, auth, rateLimit, guard, proxy);
  });

  app.use((req, res) => res.status(404).json({ error: 'not_found' }));

  async function close() { await redis.quit().catch(() => {}); }
  return { app, redis, breakers, metrics, close, ready: () => waitReady(redis) };
}

module.exports = { createApp };
