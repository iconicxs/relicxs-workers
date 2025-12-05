const { validateMachinistJob } = require('./machinist.utils');
const { recordJobStart, recordJobEnd } = require('../../job-system/metrics');
const { sendToDLQ } = require('../../resilience/dlq');
const { logStart, logEnd, logFailure } = require('../../resilience/logging');

/**
 * Placeholder for future batch-based image processing.
 * Right now it only validates, logs, and exits cleanly.
 */
async function processBatchMachinistJob(logger, rawJob) {
  const job = validateMachinistJob(rawJob);

  try { await recordJobStart(job); } catch (_) {}
  logStart(logger, job);

  try {
    logger.info({ tenant_id: job.tenant_id, asset_id: job.asset_id }, '[MACHINIST][BATCH] Received job — batch processing is not implemented yet');

    const result = { status: 'skipped', reason: 'batch_not_implemented' };
    logEnd(logger, job, result);
    return result;
  } catch (err) {
    logFailure(logger, job, err);
    try { await sendToDLQ(job, err.message || String(err), logger); } catch (_) {}
    throw err;
  } finally {
    try { await recordJobEnd(job); } catch (_) {}
  }
}

module.exports = { processBatchMachinistJob };
