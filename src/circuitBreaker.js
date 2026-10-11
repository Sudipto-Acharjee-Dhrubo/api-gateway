// Per-upstream circuit breaker: CLOSED -> OPEN -> HALF_OPEN -> CLOSED
//
//  CLOSED    normal traffic; consecutive failures are counted
//  OPEN      upstream is considered dead; requests are rejected instantly (503)
//  HALF_OPEN after `openMs`, exactly ONE probe request is let through.
//            success -> CLOSED, failure -> OPEN again
//
// State is per gateway process. With several gateway instances, each one
// protects itself independently (a fine trade-off; mention it in your report).
class CircuitBreaker {
  constructor(name, { failureThreshold = 5, openMs = 10000 } = {}, now = () => Date.now()) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.openMs = openMs;
    this.now = now;
    this.state = 'CLOSED';
    this.failures = 0;
    this.openedAt = 0;
    this.probeInFlight = false;
  }

  // Returns true if a request may go to the upstream right now.
  allow() {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') {
      if (this.now() - this.openedAt >= this.openMs) {
        this.state = 'HALF_OPEN';
        this.probeInFlight = true;
        return true; // this request is the probe
      }
      return false;
    }
    // HALF_OPEN: only the single probe is allowed
    if (!this.probeInFlight) {
      this.probeInFlight = true;
      return true;
    }
    return false;
  }

  recordSuccess() {
    this.failures = 0;
    this.probeInFlight = false;
    this.state = 'CLOSED';
  }

  recordFailure() {
    this.probeInFlight = false;
    if (this.state === 'HALF_OPEN') return this._open();
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this._open();
  }

  _open() {
    this.state = 'OPEN';
    this.openedAt = this.now();
  }

  retryAfterSec() {
    return Math.max(1, Math.ceil((this.openMs - (this.now() - this.openedAt)) / 1000));
  }
}

module.exports = { CircuitBreaker };
