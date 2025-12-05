/**
 * Machinist instant priority queue helpers.
 */
const { logger } = require('../../core/logger');
const { MACHINIST } = require('../../priorities/priority.constants');
const { pushJob, popJob, requeueJob, getRedisClient } = require('../../core/redis');
const { queueDepth } = require('../../metrics/prometheus');

const log = logger.child({ component: 'queue:machinist:instant' });

function validateJob(job) {
  if (!job || typeof job !== 'object') throw new Error('Invalid job: not an object');
  if (!job.tenant_id) throw new Error('Invalid job: missing tenant_id');
  if (!job.job_type && !job.file_purpose) throw new Error('Invalid job: missing job_type/file_purpose');
}

async function enqueue(job) {
  validateJob(job);
  log.info({ tenant_id: job.tenant_id, job_type: job.job_type }, 'Enqueue machinist instant');
  await pushJob(MACHINIST.INSTANT, job);
  try {
    const redis = await getRedisClient();
    const depth = await redis.lLen(MACHINIST.INSTANT);
    queueDepth.labels('machinist', 'instant').set(depth);
  } catch (_) {}
}

async function dequeue() {
  const job = await popJob(MACHINIST.INSTANT);
  if (job) log.info({ tenant_id: job.tenant_id, job_type: job.job_type }, 'Dequeue machinist instant');
  return job;
}

async function requeue(job) {
  validateJob(job);
  log.warn({ tenant_id: job.tenant_id, job_type: job.job_type }, 'Requeue machinist instant');
  await requeueJob(MACHINIST.INSTANT, job);
}

module.exports = { enqueue, dequeue, requeue };
