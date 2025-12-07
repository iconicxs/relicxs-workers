require('../module-aliases');
const http = require('http');
const { getWorkerHealth } = require('../resilience/health');
const { registry } = require('../metrics/prometheus');
const { MINIMAL_MODE } = require('../core/config');
const { getRedisClient } = require('../core/redis');
const { resolveQueueForJob } = require('../priorities/priority.router');

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
  // Lightweight enqueue endpoint for admin console
  // POST /enqueue  Authorization: Bearer <ENQUEUE_TOKEN>
  // Body: { job_type: 'machinist', processing_type: 'instant'|'standard', tenant_id, batch_id, asset_id, file_purpose, original_extension }
  if (req.method === 'POST' && req.url === '/enqueue') {
    try {
      // Auth
      const header = req.headers['authorization'] || '';
      const token = (header.startsWith('Bearer ') ? header.slice(7) : '').trim();
      if (!process.env.ENQUEUE_TOKEN || token !== process.env.ENQUEUE_TOKEN) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }

      // Read body
      const chunks = [];
      await new Promise((resolve, reject) => {
        req.on('data', (c) => chunks.push(c));
        req.on('end', resolve);
        req.on('error', reject);
      });
      let job = {};
      try { job = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {}

      // Minimal validation
      if (!job || typeof job !== 'object') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid_body' }));
      }
      // Ensure job_type defaults to machinist if omitted
      if (!job.job_type && !job.type) job.job_type = 'machinist';

      // Resolve queue and enqueue
      let queue;
      try {
        queue = resolveQueueForJob(job);
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid_job', message: err && err.message }));
      }
      try {
        const redis = await getRedisClient();
        await redis.lPush(queue, JSON.stringify(job));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'enqueue_failed', message: e && e.message }));
      }

      res.writeHead(202, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ queued: true, queue }));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'server_error', message: err && err.message }));
    }
  }
  // Admin enqueue endpoint (basic scaffold)
  if (req.method === 'POST' && req.url === '/admin/jobs') {
    try {
      // simple token auth: set ADMIN_API_TOKEN in env to enable
      const adminToken = process.env.ADMIN_API_TOKEN;
      if (adminToken) {
        const auth = req.headers.authorization || '';
        if (!auth.startsWith('Bearer ') || auth.slice(7) !== adminToken) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
      } else {
        // reject if no admin token configured (safer default)
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'admin API not enabled' }));
        return;
      }

      // collect body
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const { namespace, priority, job } = payload;
          const allowedNs = ['machinist', 'archivist'];
          const allowedPr = ['instant', 'standard', 'batch'];
          if (!allowedNs.includes(namespace) || !allowedPr.includes(priority) || typeof job !== 'object') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid payload; require namespace, priority, job' }));
            return;
          }

          // dynamic require of the appropriate queue helper
          const queuePath = `../queues/${namespace}/${priority}.queue`;
          let queueHelper;
          try {
            queueHelper = require(queuePath);
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `queue helper not found: ${queuePath}` }));
            return;
          }

          // enqueue (may throw if validation fails)
          await queueHelper.enqueue(job);
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, queued: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
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
