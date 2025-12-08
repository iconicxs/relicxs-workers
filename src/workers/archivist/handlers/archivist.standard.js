const { validateArchivistJob } = require('@schema/job-schemas');
const { runArchivistPipeline } = require('../archivist.pipeline');
const { withRetry } = require('../../../resilience/retry');
const wrap = require('../../../errors/wrap');
const config = require('../../../core/config');
const { recordJobStart, recordJobEnd } = require('../../../metrics/runtime');
const { sendToDLQ } = require('../../../resilience/dlq');
const { logStart, logEnd, logFailure } = require('../../../resilience/logging');

async function processStandardArchivistJob(logger, rawJob) {
  const job = validateArchivistJob(rawJob);

  try { await recordJobStart(job); } catch (_) {}
  logStart(logger, job);

  try {
    if (config.dryRun) {
      logger.warn(`[DRY_RUN] Skipping archivist.standard for asset ${job.asset_id}`);
      const res = { dryRun: true };
      logEnd(logger, job, res);
      return res;
    }

    const res = await wrap(
      () => withRetry(
        () => runArchivistPipeline(logger, job),
        { logger, maxRetries: 2, baseDelay: 500, context: { step: 'archivist-pipeline-standard' } }
      ),
      logger,
      { step: 'archivist-pipeline-standard' }
    );

    logEnd(logger, job, res);
    return res;
  } catch (err) {
    logFailure(logger, job, err);
    try { await sendToDLQ(job, err.message || String(err), logger); } catch (_) {}
    throw err;
  } finally {
    try { await recordJobEnd(job); } catch (_) {}
  }
}

module.exports = { processStandardArchivistJob };
