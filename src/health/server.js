require('../module-aliases');
const http = require('http');
const { getWorkerHealth } = require('../resilience/health');
const { registry } = require('../metrics/prometheus');
const { MINIMAL_MODE } = require('../core/config');

const config = require('../core/config');
const PORT = Number(config.healthPort || 8081);

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    try {
      if (MINIMAL_MODE) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mode: 'minimal' }));
      } else {
        const data = await getWorkerHealth();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      }
    } catch (err) {
      const code = MINIMAL_MODE ? 200 : 500;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(MINIMAL_MODE ? { ok: true, mode: 'minimal' } : { error: err.message }));
    }
    return;
  }
  if (req.method === 'GET' && req.url === '/metrics') {
    try {
      const metrics = await registry.metrics();
      res.writeHead(200, { 'Content-Type': registry.contentType });
      res.end(metrics);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`# metrics error: ${err.message}\n`);
    }
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => console.log(`[HEALTH] Server listening on ${PORT}`));

module.exports = { server };
