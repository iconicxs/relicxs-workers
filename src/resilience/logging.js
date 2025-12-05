/**
 * Standardized logging helpers for worker lifecycle.
 */
function logStart(logger, job) {
  logger.info({ tenant_id: job.tenant_id, asset_id: job.asset_id, batch_id: job.batch_id }, 'JOB_START');
}

function logEnd(logger, job, result) {
  logger.info({ tenant_id: job.tenant_id, asset_id: job.asset_id, batch_id: job.batch_id, result }, 'JOB_END');
}

function logFailure(logger, job, error) {
  logger.error({ tenant_id: job.tenant_id, asset_id: job.asset_id, batch_id: job.batch_id, err: error && error.message }, 'JOB_FAILURE');
}

module.exports = { logStart, logEnd, logFailure };
