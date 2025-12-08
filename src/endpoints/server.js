require('../module-aliases');
const http = require('http');
const { getWorkerHealth } = require('../resilience/health');
const { registry } = require('../metrics/prometheus');
const { MINIMAL_MODE } = require('../core/config');
const { exec } = require('child_process');
const { promisify } = require('util');
const execp = promisify(exec);
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

  if (req.method === 'POST' && req.url === '/enqueue') {
    try {
      const token = getBearerToken(req);
      const expected = process.env.ENQUEUE_TOKEN || process.env.WORKER_ENQUEUE_TOKEN;
      if (!expected || token !== expected) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }

      let job = await readBody(req);
      if (!job || typeof job !== 'object') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid_body' }));
      }
      if (!job.job_type && !job.type) job.job_type = 'machinist';
      // Compatibility shim: normalize legacy processing_type 'batch' to 'jobgroup'
      if (job && typeof job.processing_type === 'string' && job.processing_type.toLowerCase() === 'batch') {
        job.processing_type = 'jobgroup';
      }
      // Explicitly reject machinist batch/jobgroup priorities
      const jt = String(job.job_type || job.type || '').toLowerCase();
      const pt = String(job.processing_type || job.processingType || '').toLowerCase();
      if (jt.startsWith('machinist') && pt === 'jobgroup') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unsupported_priority', message: 'Machinist does not support batch/jobgroup priority' }));
      }

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

  if (req.method === 'GET' && req.url.startsWith('/queues/overview')) {
    if (!isAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    try {
      const redis = await getRedisClient();
      const {
        MACHINIST_QUEUE_INSTANT, MACHINIST_QUEUE_STANDARD,
        ARCHIVIST_QUEUE_INSTANT, ARCHIVIST_QUEUE_STANDARD, ARCHIVIST_QUEUE_JOBGROUP,
      } = require('../priorities/priority.constants');
      const keys = [
        MACHINIST_QUEUE_INSTANT, MACHINIST_QUEUE_STANDARD,
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

  // DLQ endpoints (admin console compatibility)
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

  // Admin enqueue endpoint (basic scaffold — preserved for console compatibility)
  if (req.method === 'POST' && req.url === '/admin/jobs') {
    try {
      const adminToken = process.env.ADMIN_API_TOKEN;
      if (adminToken) {
        const auth = req.headers.authorization || '';
        if (!auth.startsWith('Bearer ') || auth.slice(7) !== adminToken) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
      } else {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'admin API not enabled' }));
        return;
      }

      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const { namespace, priority, job } = payload;
          const allowedNs = ['machinist', 'archivist'];
          const allowedPr = ['instant', 'standard', 'batch', 'jobgroup'];
          if (!allowedNs.includes(namespace) || !allowedPr.includes(priority) || typeof job !== 'object') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid payload; require namespace, priority, job' }));
            return;
          }

          // Map deprecated batch to jobgroup for archivist
          const pr = (namespace === 'archivist' && priority === 'batch') ? 'jobgroup' : priority;
          if (namespace === 'machinist' && (pr === 'batch' || pr === 'jobgroup')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unsupported_priority', message: 'Machinist does not support batch/jobgroup' }));
            return;
          }

          const queuePath = `../queues/${namespace}/${pr}.queue`;
          let queueHelper;
          try {
            queueHelper = require(queuePath);
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `queue helper not found: ${queuePath}` }));
            return;
          }

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

  if (req.method === 'POST' && req.url === '/admin/pm2') {
    try {
      if (!isAuthorized(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden' }));
        return;
      }

      const body = await readBody(req);
      const action = (body && body.action) || '';
      let name = (body && body.name) || '';
      // Back-compat: allow old process name
      if (name === 'health-server') name = 'endpoints-server';
      const allowed = new Set(['stop', 'restart', 'reload', 'start', 'delete', 'gracefulReload']);
      if (!allowed.has(action) || !name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_payload', allowed: Array.from(allowed) }));
        return;
      }

      const cmd = `pm2 ${action} ${name}`;
      try {
        const { stdout, stderr } = await execp(cmd);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, cmd, stdout: String(stdout).slice(0, 2000), stderr: String(stderr).slice(0, 2000) }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'pm2_failed', message: err.message, stack: err.stack }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/admin/pm2/list') {
    try {
      if (!isAuthorized(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden' }));
        return;
      }

      try {
        const { stdout } = await execp('pm2 jlist');
        let list = [];
        try { list = JSON.parse(stdout || '[]'); } catch { list = []; }
        const mapped = list.map((p) => ({
          id: p.pm_id,
          name: p.name,
          pid: p.pid,
          status: p.pm2_env && p.pm2_env.status,
          restarts: p.pm2_env && p.pm2_env.restart_time,
          uptime: p.pm2_env && p.pm2_env.pm_uptime,
          cpu: p.monit && p.monit.cpu,
          memory: p.pm2_env && p.pm2_env.memory,
          version: p.pm2_env && p.pm2_env.version,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ processes: mapped }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'pm2_list_failed', message: err.message }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => console.log(`[ENDPOINTS] Server listening on ${PORT}`));

module.exports = { server };
