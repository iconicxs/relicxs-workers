require('../../module-aliases');

const { initializeWorkerEnvironment } = require('../../startup/initialize');
const { getRedisClient } = require('../../core/redis');
const { processInstantMachinistJob } = require('./machinist.instant');
const { processStandardMachinistJob } = require('./machinist.standard');
const { processBatchMachinistJob } = require('./machinist.batch');
const { MACHINIST_QUEUE_INSTANT, MACHINIST_QUEUE_STANDARD, MACHINIST_QUEUE_JOBGROUP } = require('../../priorities/priority.constants');
const { DLQ_QUEUE } = require('../dlq/dlq.constants');

const LISTEN_QUEUES = [MACHINIST_QUEUE_INSTANT, MACHINIST_QUEUE_STANDARD, MACHINIST_QUEUE_JOBGROUP];
const BRPOP_TIMEOUT_SECONDS = 30;

/**
 * Blocking loop to consume machinist jobs using BRPOP.
 * This loop processes one job at a time, sequentially.
 * @param {import('pino').Logger} logger
 */
async function startMachinistWorker(logger) {
  const redis = await getRedisClient();
  logger.info({ queues: LISTEN_QUEUES, timeout: BRPOP_TIMEOUT_SECONDS }, '[MACHINIST] Starting blocking worker loop');

  /* eslint-disable no-constant-condition */
  while (true) {
    try {
      // BRPOP returns array [key, element] or null on timeout
      const result = await redis.brPop(LISTEN_QUEUES, BRPOP_TIMEOUT_SECONDS);

      if (!result) {
        // Timeout: no job, just loop again
        logger.debug(
          { queues: LISTEN_QUEUES },
          '[MACHINIST] BRPOP timeout, no jobs available'
        );
        continue;
      }

      const { key, element } = Array.isArray(result)
        ? { key: result[0], element: result[1] }
        : result;

      logger.debug({ queue: key }, '[MACHINIST] BRPOP returned element');

      let parsedJob;
      try {
        parsedJob = JSON.parse(element);
      } catch (parseErr) {
        logger.error({ err: parseErr, raw: element }, '[MACHINIST] Failed to parse job JSON');
        // Push raw element to failed queue
        await redis.rPush(DLQ_QUEUE, element);
        continue;
      }

      try {
        if (key === MACHINIST_QUEUE_INSTANT) {
          await processInstantMachinistJob(logger, parsedJob);
        } else if (key === MACHINIST_QUEUE_STANDARD) {
          await processStandardMachinistJob(logger, parsedJob);
        } else if (key === MACHINIST_QUEUE_JOBGROUP) {
          await processBatchMachinistJob(logger, parsedJob);
        }
      } catch (jobErr) {
        logger.error(
          {
            err: jobErr,
            tenant_id: parsedJob && parsedJob.tenant_id,
            asset_id: parsedJob && parsedJob.asset_id,
          },
          '[MACHINIST] Error while processing job, moving to failed queue'
        );
        await redis.rPush(DLQ_QUEUE, element);
      }
    } catch (loopErr) {
      logger.error({ err: loopErr }, '[MACHINIST] Unexpected error in worker loop, will retry after delay');
      try {
        const msg = JSON.stringify({ error: 'worker_loop_error', message: loopErr && loopErr.message ? loopErr.message : String(loopErr), raw: null, ts: Date.now() });
        await redis.rPush(DLQ_QUEUE, msg);
      } catch (_) {}
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  /* eslint-enable no-constant-condition */
}

// Bootstrap IIFE
(async () => {
  try {
    const { logger } = await initializeWorkerEnvironment({
      componentName: 'machinist-worker',
    });
    await startMachinistWorker(logger);
  } catch (err) {
    // At this level we cannot recover; log and exit.
    // logger may not be initialized if initializeWorkerEnvironment failed.
    // So we use console.error as a last resort.
    // eslint-disable-next-line no-console
    console.error('[MACHINIST] Fatal error during startup:', err);
    process.exit(1);
  }
})();
