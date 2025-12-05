const { getRedisClient } = require('../../core/redis');
const { DLQ_QUEUE } = require('./dlq.constants');
const { DLQEntry } = require('./dlq.types');
const { dlqFailures } = require('../../metrics/prometheus');

/**
 * Push an entry to the DLQ.
 */
async function sendToDLQ(job, error, logger) {
  const redis = await getRedisClient();
  const entry = new DLQEntry({ job, error, ts: Date.now() });
  const msg = JSON.stringify(entry);
  logger.warn({ job, error }, '[DLQ] Sending job to DLQ');
  await redis.rPush(DLQ_QUEUE, msg);
  try { dlqFailures.labels(error || 'unknown').inc(); } catch (_) {}
}

module.exports = { sendToDLQ };
