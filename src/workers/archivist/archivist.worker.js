require('../../module-aliases');
const os = require('os');
const path = require('path');
const { initializeWorkerEnvironment } = require('../../startup/initialize');
const { instantQueue, standardQueue, batchQueue } = require('../../queues/archivist');
const { PROCESSING_CONFIG, validateArchivistJob } = require('./archivist.utils');
const { processInstantArchivistJob } = require('./handlers/archivist.instant');
const { processStandardArchivistJob } = require('./handlers/archivist.standard');
const { processBatchArchivistJob } = require('./handlers/archivist.jobgroup');
const { startJobgroupPolling } = require('./jobgroup/archivist.jobgroup.poller');

let shuttingDown = false;

/**
 * Helper: sleep for a given number of milliseconds.
 * @param {number} ms
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main polling loop for the archivist worker.
 * Priority order:
 * 1. INSTANT queue (single job)
 * 2. STANDARD queue (accumulate jobs for batching)
 * 3. BATCH queue (jobgroup)
 *
 * @param {import('pino').Logger} logger
 */
async function startArchivistPollingLoop(logger) {
  logger.info({}, '[ARCHIVIST] Starting AI analysis worker polling loop (hybrid priority system)');

  while (!shuttingDown) {
    let didWork = false;

    // 1) INSTANT queue: process one job if available
    try {
      const instantJob = await instantQueue.dequeue();
      if (instantJob) {
        didWork = true;
        logger.debug({ tenant_id: instantJob.tenant_id, asset_id: instantJob.asset_id, ai_description_id: instantJob.ai_description_id }, '[ARCHIVIST] Dequeued INSTANT job');

        try {
          await processInstantArchivistJob(logger, instantJob);
        } catch (err) {
          logger.error({ err, job: instantJob }, '[ARCHIVIST] Error while processing INSTANT job (placeholder)');
        }
      }
    } catch (err) {
      logger.error({ err }, '[ARCHIVIST] Error while reading INSTANT queue');
    }

    // 2) STANDARD queue: process one job per loop
    try {
      const standardJob = await standardQueue.dequeue();
      if (standardJob) {
        didWork = true;
        logger.debug({ tenant_id: standardJob.tenant_id, asset_id: standardJob.asset_id, ai_description_id: standardJob.ai_description_id }, '[ARCHIVIST] Dequeued STANDARD job');
        try {
          await processStandardArchivistJob(logger, standardJob);
        } catch (err) {
          logger.error({ err, job: standardJob }, '[ARCHIVIST] Error while processing STANDARD job');
        }
      }
    } catch (err) {
      logger.error({ err }, '[ARCHIVIST] Error while reading STANDARD queue');
    }

    // 3) BATCH queue: jobgroup (OpenAI Batch API)
    try {
      const batchJob = await batchQueue.dequeue();
      if (batchJob) {
        didWork = true;
        const batchId = batchJob.batch_id || 'unknown';

        logger.debug({ tenant_id: batchJob.tenant_id, asset_id: batchJob.asset_id, ai_description_id: batchJob.ai_description_id, batch_id: batchId }, '[ARCHIVIST] Dequeued BATCH job');

        // Directly hand off to jobgroup processor
        try {
          const workDir = path.join(os.tmpdir(), `archivist-jobgroup-${batchId}-${Date.now()}`);
          await processBatchArchivistJob(logger, { jobs: [batchJob], workDir });
        } catch (err) {
          logger.error({ err, job: batchJob }, '[ARCHIVIST] Error while processing BATCH job');
        }
      }
    } catch (err) {
      logger.error({ err }, '[ARCHIVIST] Error while reading BATCH queue');
    }

    // If we didn't do any work this loop, sleep a bit to avoid hot spinning
    if (!didWork) {
      await delay(1000);
    }
  }

  logger.info({}, '[ARCHIVIST] Polling loop stopped due to shutdown flag');
}

// Bootstrap IIFE
(async () => {
  try {
    const { logger } = await initializeWorkerEnvironment({ componentName: 'archivist-worker' });
    // Start jobgroup poller (OpenAI Batch API)
    startJobgroupPolling(logger);
    
    await startArchivistPollingLoop(logger);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[ARCHIVIST] Fatal error during startup:', err);
    process.exit(1);
  }
})();
