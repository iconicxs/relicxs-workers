const { getRedisClient } = require('../core/redis');
const { runningJobs, jobDuration } = require('./prometheus');

function deriveJobKey(job) {
  if (job && job.id) return String(job.id);
  const t = job && job.tenant_id ? job.tenant_id : 'unknown_t';
  const b = job && job.batch_id ? job.batch_id : 'unknown_b';
  const a = job && job.asset_id ? job.asset_id : 'unknown_a';
  const composite = `${t}:${b}:${a}`;
  if (composite.includes('unknown')) {
    return `${composite}:${Date.now()}:${Math.random().toString(36).slice(2,8)}`;
  }
  return composite;
}

async function recordJobStart(job) {
  const redis = await getRedisClient();
  const runningKey = `metrics:${job.priority}:running`;

  await redis.incr(runningKey);
  const key = deriveJobKey(job);
  await redis.hSet(`metrics:job:start`, key, Date.now());

  const worker = (job && job.job_type) ? (String(job.job_type).split('.')[0] || 'unknown') : 'unknown';
  const priority = job && job.priority ? job.priority : 'unknown';
  try { runningJobs.labels(worker, priority).inc(); } catch (_) {}
}

async function recordJobEnd(job) {
  const redis = await getRedisClient();
  const runningKey = `metrics:${job.priority}:running`;

  await redis.decr(runningKey);

  const key = deriveJobKey(job);
  const start = await redis.hGet(`metrics:job:start`, key);
  if (!start) return;

  const duration = Date.now() - parseInt(start, 10);
  const listKey = `metrics:${job.priority}:durations`;

  await redis.lPush(listKey, duration);
  await redis.lTrim(listKey, 0, 999);

  await redis.hDel(`metrics:job:start`, key);

  try { jobDuration.labels((job && job.job_type) ? (String(job.job_type).split('.')[0] || 'unknown') : 'unknown', job && job.priority ? job.priority : 'unknown').observe(duration / 1000); } catch (_) {}
}

async function getAvgDuration(priority) {
  const redis = await getRedisClient();
  const values = await redis.lRange(
    `metrics:${priority}:durations`,
    0,
    -1
  );

  if (!values.length) return 0;

  const sum = values.reduce((a, b) => a + parseInt(b), 0);
  return Math.round(sum / values.length);
}

module.exports = {
  recordJobStart,
  recordJobEnd,
  getAvgDuration,
};
