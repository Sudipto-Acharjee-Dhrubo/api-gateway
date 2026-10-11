// Two layers, both per client:
//   1. Token bucket   -> smooths bursts       (plan.capacity, plan.refillPerSec)
//   2. Daily quota    -> hard cap per UTC day (plan.dailyQuota)
function createRateLimiter(config, redis, metrics) {
  return async function rateLimit(req, res, next) {
    const { id, plan: planName } = req.client;
    const plan = config.plans[planName];

    try {
      const [allowed, remaining, retryMs] = await redis.tokenBucket(
        `rl:bucket:${id}`, plan.capacity, plan.refillPerSec, 1
      );

      res.set('X-RateLimit-Limit', String(plan.capacity));
      res.set('X-RateLimit-Remaining', String(remaining));

      if (!allowed) {
        const retryAfter = Math.max(1, Math.ceil(retryMs / 1000));
        res.set('Retry-After', String(retryAfter));
        metrics.throttle(id);
        return res.status(429).json({ error: 'rate_limited', retryAfterSeconds: retryAfter });
      }

      if (plan.dailyQuota) {
        const day = new Date().toISOString().slice(0, 10);
        const key = `rl:quota:${id}:${day}`;
        const used = await redis.incr(key);
        if (used === 1) await redis.expire(key, 60 * 60 * 25);
        res.set('X-Quota-Limit', String(plan.dailyQuota));
        res.set('X-Quota-Remaining', String(Math.max(0, plan.dailyQuota - used)));
        if (used > plan.dailyQuota) {
          metrics.throttle(id);
          return res.status(429).json({ error: 'quota_exceeded', quota: plan.dailyQuota });
        }
      }
      return next();
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'rate limiter failure', err: err.message }));
      if (config.rateLimitFailOpen) {
        res.set('X-RateLimit-Status', 'degraded');
        return next();
      }
      return res.status(503).json({ error: 'rate_limiter_unavailable' });
    }
  };
}

module.exports = { createRateLimiter };
