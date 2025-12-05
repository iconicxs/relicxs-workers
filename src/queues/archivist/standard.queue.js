/**
 * Archivist standard priority queue helpers.
 */
const { logger } = require('../../core/logger');
const { ARCHIVIST } = require('../../priorities/priority.constants');
const { pushJob, popJob, requeueJob, getRedisClient } = require('../../core/redis');
const { queueDepth } = require('../../metrics/prometheus');

const log = logger.child({ component: 'queue:archivist:standard' });

function validateJob(job) {
  if (!job || typeof job !== 'object') throw new Error('Invalid job: not an object');
  if (!job.tenant_id) throw new Error('Invalid job: missing tenant_id');
  if (!job.job_type && !job.processing_type) throw new Error('Invalid job: missing job_type/processing_type');
}

async function enqueue(job) {
  validateJob(job);
  log.info({ tenant_id: job.tenant_id, job_type: job.job_type }, 'Enqueue archivist standard');
  await pushJob(ARCHIVIST.STANDARD, job);
  try {
    const redis = await getRedisClient();
    const depth = await redis.lLen(ARCHIVIST.STANDARD);
    queueDepth.labels('archivist', 'standard').set(depth);
  } catch (_) {}
}

async function dequeue() {
  const job = await popJob(ARCHIVIST.STANDARD);
  if (job) log.info({ tenant_id: job.tenant_id, job_type: job.job_type }, 'Dequeue archivist standard');
  return job;
}

async function requeue(job) {
  validateJob(job);
  log.warn({ tenant_id: job.tenant_id, job_type: job.job_type }, 'Requeue archivist standard');
  await requeueJob(ARCHIVIST.STANDARD, job);
}

module.exports = { enqueue, dequeue, requeue };
