/**
 * Archivist instant priority queue helpers.
 */
const { logger } = require('../../core/logger');
const { ARCHIVIST } = require('../../priorities/priority.constants');
const { pushJob, popJob, requeueJob, getRedisClient } = require('../../core/redis');
const { queueDepth } = require('../../metrics/prometheus');

const log = logger.child({ component: 'queue:archivist:instant' });

function validateJob(job) {
  if (!job || typeof job !== 'object') throw new Error('Invalid job: not an object');
  if (!job.tenant_id) throw new Error('Invalid job: missing tenant_id');
  if (!job.job_type && !job.processing_type) throw new Error('Invalid job: missing job_type/processing_type');
}

async function enqueue(job) {
  validateJob(job);
  log.info({ tenant_id: job.tenant_id, job_type: job.job_type }, 'Enqueue archivist instant');
  await pushJob(ARCHIVIST.INSTANT, job);
  try {
    const redis = await getRedisClient();
    const depth = await redis.lLen(ARCHIVIST.INSTANT);
    queueDepth.labels('archivist', 'instant').set(depth);
  } catch (_) {}
}

async function dequeue() {
  const job = await popJob(ARCHIVIST.INSTANT);
  if (job) log.info({ tenant_id: job.tenant_id, job_type: job.job_type }, 'Dequeue archivist instant');
  return job;
}

async function requeue(job) {
  validateJob(job);
  log.warn({ tenant_id: job.tenant_id, job_type: job.job_type }, 'Requeue archivist instant');
  await requeueJob(ARCHIVIST.INSTANT, job);
}

module.exports = { enqueue, dequeue, requeue };
