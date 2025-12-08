const { validateMachinistJob, validateImageBuffer, detectMime } = require('./machinist.utils');
const { recordJobStart, recordJobEnd } = require('../../metrics/runtime');
const { runMachinistPipeline } = require('./machinist.pipeline');
const { withRetry } = require('../../resilience/retry');
const { sendToDLQ } = require('../../resilience/dlq');
const { logStart, logEnd, logFailure } = require('../../resilience/logging');
const { updateBatchStatus } = require('../../resilience/batch-status');
const { wrap } = require('../../errors/wrap');

/**
 * Process a single machinist job (image processing) by running the pipeline with resilience.
 * @param {import('pino').Logger} logger
 * @param {any} rawJob
 */
async function processInstantMachinistJob(logger, rawJob) {
  const job = validateMachinistJob(rawJob);
  try { await recordJobStart(job); } catch (_) {}
  logStart(logger, job);
  logger.info({
    tenant_id: job.tenant_id,
    asset_id: job.asset_id,
    purpose: job.file_purpose,
    processing: job.processing_type
  }, '[JOB] Validated + starting pipeline');
  try {
    // Phase 2: validate in-memory buffer when supplied
    if (rawJob && rawJob.input_buffer && Buffer.isBuffer(rawJob.input_buffer)) {
      await validateImageBuffer(rawJob.input_buffer);
      const det = detectMime(rawJob.input_buffer);
      if (!det || !det.mime) throw new Error('UNSUPPORTED_MIME');
    }
    const result = await wrap(() => withRetry(() => runMachinistPipeline(logger, job), { maxRetries: 2, baseDelay: 500, logger, context: { tenant: job.tenant_id, asset: job.asset_id } }), logger, { step: 'machinist-pipeline' });
    logEnd(logger, job, result);
    try { await updateBatchStatus(job.batch_id); } catch (e) { logger.warn({ e }, '[MACHINIST] updateBatchStatus failed'); }
    return result;
  } catch (err) {
    logFailure(logger, job, err);
    try { await sendToDLQ(job, err.message || String(err), logger); } catch (e) { logger.error({ e }, '[MACHINIST] sendToDLQ failed'); }
    throw err;
  }
  finally {
    try { await recordJobEnd(job); } catch (_) {}
  }
}

module.exports = { processInstantMachinistJob };
