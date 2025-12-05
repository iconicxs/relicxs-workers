/**
 * Machinist standard priority queue helpers.
 */
const { logger } = require('../../core/logger');
const { MACHINIST } = require('../../priorities/priority.constants');
const { pushJob, popJob, requeueJob, getRedisClient } = require('../../core/redis');
const { queueDepth } = require('../../metrics/prometheus');

const log = logger.child({ component: 'queue:machinist:standard' });

function validateJob(job) {
  if (!job || typeof job !== 'object') throw new Error('Invalid job: not an object');
  if (!job.tenant_id) throw new Error('Invalid job: missing tenant_id');
  if (!job.job_type && !job.file_purpose) throw new Error('Invalid job: missing job_type/file_purpose');
}

async function enqueue(job) {
  validateJob(job);
  log.info({ tenant_id: job.tenant_id, job_type: job.job_type }, 'Enqueue machinist standard');
  await pushJob(MACHINIST.STANDARD, job);
  try {
    const redis = await getRedisClient();
    const depth = await redis.lLen(MACHINIST.STANDARD);
    queueDepth.labels('machinist', 'standard').set(depth);
  } catch (_) {}
}

async function dequeue() {
  const job = await popJob(MACHINIST.STANDARD);
  if (job) log.info({ tenant_id: job.tenant_id, job_type: job.job_type }, 'Dequeue machinist standard');
  return job;
}

async function requeue(job) {
  validateJob(job);
  log.warn({ tenant_id: job.tenant_id, job_type: job.job_type }, 'Requeue machinist standard');
  await requeueJob(MACHINIST.STANDARD, job);
}

module.exports = { enqueue, dequeue, requeue };
