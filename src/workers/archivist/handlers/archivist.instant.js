const { validateArchivistJob } = require('@schema/job-schemas');
const { runArchivistPipeline } = require('../archivist.pipeline');
const { runJobgroupArchivist } = require('./archivist.jobgroup');
const config = require('../../../core/config');
const os = require('os');
const path = require('path');
const fse = require('fs-extra');
const { withRetry } = require('../../../resilience/retry');
const { sendToDLQ } = require('../../../resilience/dlq');
const { logStart, logEnd, logFailure } = require('../../../resilience/logging');
const { updateBatchStatus } = require('../../../resilience/batch-status');
const { wrap } = require('../../../errors/wrap');
const { recordJobStart, recordJobEnd } = require('../../../metrics/runtime');

async function processInstantArchivistJob(logger, rawJob) {
  const job = validateArchivistJob(rawJob);
  try { await recordJobStart(job); } catch (_) {}
  logStart(logger, job);
  logger.info({
    tenant_id: job.tenant_id,
    asset_id: job.asset_id,
    purpose: job.file_purpose,
    processing: job.processing_type
  }, '[JOB] Validated + starting pipeline');
  try {
    if (config.dryRun) {
      logger.warn(`[DRY_RUN] Skipping archivist.instant for asset ${job.asset_id}`);
      return { dryRun: true };
    }
    let res;
    if (job.processing_type === 'jobgroup') {
      const workDir = path.join(os.tmpdir(), `archivist-jobgroup-${job.tenant_id}-${Date.now()}`);
      fse.ensureDirSync(workDir);
      res = await wrap(() => withRetry(() => runJobgroupArchivist({ logger, jobs: [job], workDir }), { maxRetries: 2, baseDelay: 500, logger, context: { tenant: job.tenant_id, asset: job.asset_id } }), logger, { step: 'archivist-jobgroup' });
    } else {
      res = await wrap(() => withRetry(() => runArchivistPipeline(logger, job), { maxRetries: 2, baseDelay: 500, logger, context: { tenant: job.tenant_id, asset: job.asset_id } }), logger, { step: 'archivist-pipeline' });
    }
    logEnd(logger, job, res);
    try { await updateBatchStatus(job.batch_id); } catch (e) { logger.warn({ e }, '[ARCHIVIST] updateBatchStatus failed'); }
    return res;
  } catch (err) {
    logFailure(logger, job, err);
    try { await sendToDLQ(job, err.message || String(err), logger); } catch (e) { logger.error({ e }, '[ARCHIVIST] sendToDLQ failed'); }
    throw err;
  }
  finally {
    try { await recordJobEnd(job); } catch (_) {}
  }
}

module.exports = { processInstantArchivistJob };
