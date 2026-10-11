const { loadConfig } = require('./config');
const { createApp } = require('./app');

const config = loadConfig();
if (config.jwtSecret === 'dev-only-change-me' && process.env.NODE_ENV === 'production') {
  console.error('Refusing to start: set JWT_SECRET in production');
  process.exit(1);
}

const { app, close, ready } = createApp(config);

ready().then((ok) => {
  if (!ok) console.error(JSON.stringify({ level: 'warn', msg: 'redis not ready, starting anyway',
    failOpen: config.rateLimitFailOpen }));
  const server = app.listen(config.port, () => {
    console.log(JSON.stringify({ level: 'info', msg: 'gateway listening', port: config.port,
      routes: config.routes.map((r) => `${r.prefix} -> ${r.target}`) }));
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => server.close(async () => { await close(); process.exit(0); }));
  }
});
