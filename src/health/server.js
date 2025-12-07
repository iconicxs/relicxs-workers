require('../module-aliases');
const http = require('http');
const { getWorkerHealth } = require('../resilience/health');
const { registry } = require('../metrics/prometheus');
const { MINIMAL_MODE } = require('../core/config');
const { getRedisClient } = require('../core/redis');
const { resolveQueueForJob } = require('../priorities/priority.router');

const config = require('../core/config');
const PORT = Number(config.healthPort || 8081);

function getBearerToken(req) {
  const header = req.headers['authorization'] || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function isAuthorized(req) {
  const token = getBearerToken(req);
  const allow = [
    process.env.ENQUEUE_TOKEN,
    process.env.WORKER_ENQUEUE_TOKEN,
    process.env.ADMIN_API_TOKEN,
  ].filter(Boolean);
  if (allow.length === 0) return false;
  return allow.includes(token);
}

async function readBody(req) {
  const chunks = [];
  await new Promise((resolve, reject) => {
    req.on('data', (c) => chunks.push(c));
    req.on('end', resolve);
    req.on('error', reject);
  });
  const s = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

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
      const token = getBearerToken(req);
      const expected = process.env.ENQUEUE_TOKEN || process.env.WORKER_ENQUEUE_TOKEN;
      if (!expected || token !== expected) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }

      // Read body
      let job = await readBody(req);

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
  // ------------------------------
  // Admin Queue Endpoints (token-protected)
  // ------------------------------
  if (req.method === 'GET' && req.url.startsWith('/queues/overview')) {
    if (!isAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    try {
      const redis = await getRedisClient();
      const {
        MACHINIST_QUEUE_INSTANT, MACHINIST_QUEUE_STANDARD, MACHINIST_QUEUE_JOBGROUP,
        ARCHIVIST_QUEUE_INSTANT, ARCHIVIST_QUEUE_STANDARD, ARCHIVIST_QUEUE_JOBGROUP,
      } = require('../priorities/priority.constants');
      const keys = [
        MACHINIST_QUEUE_INSTANT, MACHINIST_QUEUE_STANDARD, MACHINIST_QUEUE_JOBGROUP,
        ARCHIVIST_QUEUE_INSTANT, ARCHIVIST_QUEUE_STANDARD, ARCHIVIST_QUEUE_JOBGROUP,
        'dlq:machinist', 'image-processing:failed', 'image-processing:retry',
      ];
      const out = [];
      for (const k of keys) {
        try { out.push({ key: k, length: await redis.lLen(k) }); } catch { out.push({ key: k, length: null }); }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ queues: out }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (req.method === 'GET' && req.url.startsWith('/queues/dlq')) {
    if (!isAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    try {
      const { URL } = require('url');
      const u = new URL(req.url, `http://localhost:${PORT}`);
      const key = u.searchParams.get('key') || 'dlq:machinist';
      const offset = parseInt(u.searchParams.get('offset') || '0', 10);
      const limit = Math.min(parseInt(u.searchParams.get('limit') || '50', 10), 200);
      const redis = await getRedisClient();
      const total = await redis.lLen(key);
      const items = await redis.lRange(key, offset, offset + limit - 1);
      const parsed = items.map((s, i) => {
        try { return { idx: offset + i, parsed: JSON.parse(s), raw: null }; } catch { return { idx: offset + i, parsed: null, raw: s }; }
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ key, total, offset, limit, items: parsed }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (req.method === 'POST' && req.url === '/queues/dlq/requeue') {
    if (!isAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    try {
      const body = await readBody(req);
      const srcKey = body.srcKey || 'dlq:machinist';
      const dstKey = body.dstKey; // must be provided by caller
      const count = Math.min(parseInt(body.count || 10, 10), 1000);
      if (!dstKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'dstKey required' }));
      }
      const redis = await getRedisClient();
      let moved = 0;
      for (let i = 0; i < count; i++) {
        const raw = await redis.rPop(srcKey);
        if (!raw) break;
        await redis.rPush(dstKey, raw);
        moved++;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ srcKey, dstKey, requeued: moved }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (req.method === 'DELETE' && req.url === '/queues/dlq') {
    if (!isAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    try {
      const body = await readBody(req);
      const key = body.key || 'dlq:machinist';
      const count = Math.min(parseInt(body.count || 10, 10), 1000);
      const redis = await getRedisClient();
      let removed = 0;
      for (let i = 0; i < count; i++) {
        const raw = await redis.rPop(key);
        if (!raw) break;
        removed++;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ key, removed }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
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
  // Ops: PM2 process list (token required)
  if (req.method === 'GET' && req.url === '/ops/pm2/list') {
    if (!isAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    try {
      // Prefer programmatic API if available, else fallback to pm2 jlist
      let out = null;
      try {
        const pm2 = require('pm2');
        out = await new Promise((resolve, reject) => {
          pm2.connect((err) => {
            if (err) return reject(err);
            pm2.list((e, list) => {
              pm2.disconnect();
              if (e) return reject(e);
              resolve(list);
            });
          });
        });
      } catch (_) {
        const { exec } = require('child_process');
        out = await new Promise((resolve, reject) => {
          exec('pm2 jlist', { timeout: 2000 }, (err, stdout) => {
            if (err) return reject(err);
            try { resolve(JSON.parse(stdout)); } catch (e) { resolve({ raw: stdout }); }
          });
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ processes: out }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => console.log(`[HEALTH] Server listening on ${PORT}`));

module.exports = { server };
