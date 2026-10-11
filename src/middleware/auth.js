const jwt = require('jsonwebtoken');

// Accepts either:
//   X-API-Key: <key>                 (looked up in config/clients.json)
//   Authorization: Bearer <jwt>      (issued by POST /auth/token, HS256)
// On success sets req.client = { id, plan }.
function createAuth(config) {
  return function auth(req, res, next) {
    const apiKey = req.get('x-api-key');
    if (apiKey) {
      const client = config.clients[apiKey];
      if (!client) return res.status(401).json({ error: 'invalid_api_key' });
      req.client = { id: client.id, plan: client.plan };
      return next();
    }

    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme === 'Bearer' && token) {
      try {
        const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
        if (!config.plans[payload.plan]) return res.status(401).json({ error: 'invalid_token' });
        req.client = { id: payload.sub, plan: payload.plan };
        return next();
      } catch (e) {
        const code = e.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token';
        return res.status(401).json({ error: code });
      }
    }

    res.set('WWW-Authenticate', 'Bearer, X-API-Key');
    return res.status(401).json({ error: 'missing_credentials' });
  };
}

function issueToken(config, apiKey) {
  const client = config.clients[apiKey];
  if (!client) return null;
  const token = jwt.sign({ plan: client.plan }, config.jwtSecret, {
    algorithm: 'HS256',
    subject: client.id,
    expiresIn: config.jwtExpiresIn,
  });
  return { token, expiresIn: config.jwtExpiresIn };
}

module.exports = { createAuth, issueToken };
