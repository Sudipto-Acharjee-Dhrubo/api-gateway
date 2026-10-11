// Tiny in-process metrics registry that renders Prometheus text format.
const BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

class Metrics {
  constructor() {
    this.requests = new Map(); // "route|status" -> count
    this.throttled = new Map(); // "client" -> count
    this.latency = new Map(); // route -> { buckets[], sum, count }
    this.breakerTrips = new Map(); // route -> count
    this.startedAt = Date.now();
  }

  inc(map, key) {
    map.set(key, (map.get(key) || 0) + 1);
  }

  observe(route, status, ms) {
    this.inc(this.requests, `${route}|${status}`);
    let h = this.latency.get(route);
    if (!h) {
      h = { buckets: BUCKETS_MS.map(() => 0), sum: 0, count: 0 };
      this.latency.set(route, h);
    }
    BUCKETS_MS.forEach((b, i) => { if (ms <= b) h.buckets[i] += 1; });
    h.sum += ms;
    h.count += 1;
  }

  throttle(client) { this.inc(this.throttled, client); }
  trip(route) { this.inc(this.breakerTrips, route); }

  render(breakers = []) {
    const out = [];
    out.push('# TYPE gateway_requests_total counter');
    for (const [k, v] of this.requests) {
      const [route, status] = k.split('|');
      out.push(`gateway_requests_total{route="${route}",status="${status}"} ${v}`);
    }
    out.push('# TYPE gateway_throttled_total counter');
    for (const [client, v] of this.throttled) out.push(`gateway_throttled_total{client="${client}"} ${v}`);
    out.push('# TYPE gateway_request_duration_ms histogram');
    for (const [route, h] of this.latency) {
      BUCKETS_MS.forEach((b, i) => out.push(`gateway_request_duration_ms_bucket{route="${route}",le="${b}"} ${h.buckets[i]}`));
      out.push(`gateway_request_duration_ms_bucket{route="${route}",le="+Inf"} ${h.count}`);
      out.push(`gateway_request_duration_ms_sum{route="${route}"} ${h.sum.toFixed(2)}`);
      out.push(`gateway_request_duration_ms_count{route="${route}"} ${h.count}`);
    }
    out.push('# TYPE gateway_circuit_state gauge');
    out.push('# HELP gateway_circuit_state 0=CLOSED 1=HALF_OPEN 2=OPEN');
    const code = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 };
    for (const b of breakers) out.push(`gateway_circuit_state{upstream="${b.name}"} ${code[b.state]}`);
    out.push('# TYPE gateway_circuit_trips_total counter');
    for (const [route, v] of this.breakerTrips) out.push(`gateway_circuit_trips_total{route="${route}"} ${v}`);
    out.push('# TYPE gateway_uptime_seconds gauge');
    out.push(`gateway_uptime_seconds ${Math.floor((Date.now() - this.startedAt) / 1000)}`);
    return out.join('\n') + '\n';
  }
}

module.exports = { Metrics };
