const test = require('node:test');
const assert = require('node:assert');
const { CircuitBreaker } = require('../src/circuitBreaker');

test('opens after N failures, probes once after cooldown, closes on success', () => {
  let t = 0;
  const b = new CircuitBreaker('x', { failureThreshold: 3, openMs: 1000 }, () => t);
  assert.ok(b.allow());
  b.recordFailure(); b.recordFailure();
  assert.strictEqual(b.state, 'CLOSED');
  b.recordFailure();
  assert.strictEqual(b.state, 'OPEN');
  assert.strictEqual(b.allow(), false);

  t = 1000;                              // cooldown elapsed
  assert.strictEqual(b.allow(), true);   // the single probe
  assert.strictEqual(b.state, 'HALF_OPEN');
  assert.strictEqual(b.allow(), false);  // no second probe while first in flight

  b.recordSuccess();
  assert.strictEqual(b.state, 'CLOSED');
  assert.ok(b.allow());
});

test('failed probe re-opens the circuit', () => {
  let t = 0;
  const b = new CircuitBreaker('x', { failureThreshold: 1, openMs: 500 }, () => t);
  b.recordFailure();
  t = 500; assert.ok(b.allow());
  b.recordFailure();
  assert.strictEqual(b.state, 'OPEN');
  t = 700; assert.strictEqual(b.allow(), false);
});

test('a success resets the consecutive-failure count', () => {
  const b = new CircuitBreaker('x', { failureThreshold: 3, openMs: 1000 });
  b.recordFailure(); b.recordFailure(); b.recordSuccess(); b.recordFailure(); b.recordFailure();
  assert.strictEqual(b.state, 'CLOSED');
});
