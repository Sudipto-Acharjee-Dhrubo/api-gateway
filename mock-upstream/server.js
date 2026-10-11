// Fake upstream service for demos & tests.
//   GET  /anything        -> 200 JSON echo (shows headers the gateway forwarded)
//   POST /__fail/on|off   -> flip "broken" mode: every request returns 500
//   GET  /slow?ms=3000    -> responds after a delay
const http = require('http');

function createMock({ name = 'mock', port = 4001 } = {}) {
  let failing = false;
  let hits = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__fail/on' || url.pathname === '/__fail/off') {
      failing = url.pathname.endsWith('on');
      res.end(JSON.stringify({ failing }));
      return;
    }
    if (url.pathname === '/__hits') { res.end(JSON.stringify({ hits })); return; }
    hits += 1;
    const send = () => {
      res.setHeader('content-type', 'application/json');
      if (failing) { res.statusCode = 500; res.end(JSON.stringify({ service: name, error: 'boom' })); return; }
      res.end(JSON.stringify({ service: name, path: req.url, method: req.method,
        receivedHeaders: { 'x-client-id': req.headers['x-client-id'], 'x-client-plan': req.headers['x-client-plan'],
          'x-request-id': req.headers['x-request-id'], authorization: req.headers['authorization'],
          'x-api-key': req.headers['x-api-key'] } }));
    };
    const ms = Number(url.searchParams.get('ms')) || 0;
    url.pathname === '/slow' ? setTimeout(send, ms) : send();
  });
  return { server, listen: () => new Promise((r) => server.listen(port, r)),
           close: () => new Promise((r) => server.close(r)) };
}

if (require.main === module) {
  // Local: two mocks on 4001/4002. Hosted (Render sets PORT): one mock on $PORT.
  const ports = process.env.PORT ? [process.env.PORT]
    : process.env.MOCK_PORTS ? process.env.MOCK_PORTS.split(',') : ['4001', '4002'];
  const names = process.env.MOCK_NAME ? [process.env.MOCK_NAME] : ['users', 'orders'];
  ports.forEach((p, i) => createMock({ name: names[i] || `svc${i}`, port: Number(p) }).listen()
    .then(() => console.log(`mock ${names[i] || 'svc' + i} on :${p}`)));
}

module.exports = { createMock };
