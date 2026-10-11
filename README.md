# API Gateway with Rate Limiting

A reverse-proxy API gateway in Node.js: **auth → rate limit → circuit breaker → proxy**, with logging and Prometheus-style metrics.

```
 client ──► [ request-id + access log + metrics ]
              └─► auth (API key | JWT)
                    └─► rate limit (token bucket + daily quota, Redis)
                          └─► circuit breaker (per upstream)
                                └─► reverse proxy ──► upstream services
```

## Features
| Requirement | Where |
|---|---|
| Reverse-proxy routing with path rules | `config/routes.json`, `src/app.js` |
| API-key **and** JWT auth | `src/middleware/auth.js`, `POST /auth/token` |
| Token-bucket rate limiting in Redis (atomic Lua script) | `src/redis.js` |
| Per-client plans + daily quotas | `config/clients.json`, `src/middleware/rateLimit.js` |
| Logging + metrics | JSON access logs, `GET /metrics` |
| **Circuit breaker** with automatic recovery probing | `src/circuitBreaker.js` |

## Run locally
Needs Node 20+ and a Redis (`docker run -p 6379:6379 redis:7-alpine`, or `apt install redis-server`).

```bash
npm install
npm run mock          # fake upstreams on :4001 (users) and :4002 (orders)
npm start             # gateway on :3000   (second terminal)
node scripts/demo.js  # narrated demo of limiting + circuit breaking (third terminal)
npm test              # 14 tests; needs Redis running
```
Or everything at once: `docker compose up --build`.

Try it by hand:
```bash
curl localhost:3000/users/1 -H 'X-API-Key: demo-free-key-123'

TOKEN=$(curl -s -XPOST localhost:3000/auth/token -H 'content-type: application/json' \
        -d '{"apiKey":"demo-pro-key-456"}' | jq -r .token)
curl localhost:3000/orders/7 -H "Authorization: Bearer $TOKEN"

curl localhost:3000/metrics
```

## Design notes
**Token bucket.** Each client has `capacity` tokens, refilled at `refillPerSec`. A request costs 1 token. Bursts up to `capacity` are allowed; sustained rate is capped at the refill rate. State is `{tokens, timestamp}` in a Redis hash.
**Why Lua?** Read-refill-decide-write must be one atomic step, otherwise two gateway instances (or two concurrent requests) can both spend the same token. Redis runs a Lua script atomically. It also uses Redis's own clock (`TIME`), so gateway instances with skewed clocks still agree. See the 30-concurrent-request test.
**Circuit breaker.** `CLOSED` → 5 consecutive 5xx/errors → `OPEN` (instant 503, upstream untouched) → after `BREAKER_OPEN_MS` → `HALF_OPEN` (exactly one probe request) → success closes it, failure re-opens it.
**Failure policy.** If Redis is down, `RATE_LIMIT_FAIL_OPEN=true` (default) lets traffic through with `X-RateLimit-Status: degraded`; `false` returns 503. Availability vs. strictness is a real design trade-off, so be ready to discuss it.
**Credentials never reach upstreams.** The gateway strips `X-API-Key`/`Authorization` and forwards `X-Client-Id`, `X-Client-Plan`, `X-Request-Id` instead.

## Known limitations (good viva material)
- Breaker state is per gateway process, not shared via Redis.
- API keys live in a JSON file; a real system would store hashed keys in a database.
- `/metrics` is unauthenticated, and metrics reset on restart.
- Token bucket is per client globally, not per route.
- No HTTPS termination or WebSocket handling (the platform's proxy usually terminates TLS).

## Free deployment (Render + Upstash)
Free tiers change; check current limits first.

1. Push this repo to GitHub.
2. **Redis:** create a free database at upstash.com and copy the `rediss://...` URL (ioredis enables TLS from the scheme automatically). Render's own free Key Value is an alternative.
3. **Mock upstream (for the demo):** Render → New Web Service → your repo → Runtime *Docker* → Free. Add env var `SERVICE=mock`. Note its URL.
4. **Gateway:** another Web Service from the same repo, Runtime *Docker*, Free, health check path `/health`. Environment variables:
   `REDIS_URL`, `JWT_SECRET` (long random string), `NODE_ENV=production`,
   `UPSTREAM_USERS` and `UPSTREAM_ORDERS` = the mock service URL.
5. Test: `curl https://<gateway>.onrender.com/users/1 -H 'X-API-Key: demo-free-key-123'`

Free Render services sleep after ~15 minutes idle, so the first request after a pause is slow. Hit `/health` a minute before a demo.
`render.yaml` is included as an optional Blueprint, but I haven't verified it against Render; the dashboard steps above are the safe path.
