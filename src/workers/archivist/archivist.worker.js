require('../../module-aliases');
const os = require('os');
const path = require('path');
const { initializeWorkerEnvironment } = require('../../startup/initialize');
const { instantQueue, standardQueue, batchQueue } = require('../../queues/archivist');
const { PROCESSING_CONFIG, validateArchivistJob } = require('./archivist.utils');
const { processInstantArchivistJob } = require('./archivist.instant');
const { processStandardArchivistJob } = require('./archivist.standard');
const { processBatchArchivistJob } = require('./archivist.batch');
const { startJobgroupPolling } = require('./archivist.jobgroup.poller');

let shuttingDown = false;

// In-memory state for standard batching
let standardBatchCollection = [];
let standardBatchStartTimeMs = null;

// In-memory state for batch collections (per batch_id)
const batchCollectionsByBatchId = new Map();
const batchStartTimesByBatchId = new Map();

/**
 * Helper: sleep for a given number of milliseconds.
 * @param {number} ms
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Try to flush standard batch if thresholds are reached.
 * Called frequently from the polling loop.
 *
 * @param {import('pino').Logger} logger
 */
async function maybeFlushStandardBatch(logger) {
  const now = Date.now();

  if (!standardBatchCollection.length || !standardBatchStartTimeMs) {
    return;
  }

  const size = standardBatchCollection.length;
  const ageMs = now - standardBatchStartTimeMs;

  const { minBatchSize, maxBatchSize, maxWaitTimeMs, cleanupWaitTimeMs } = PROCESSING_CONFIG.standard;

  const hitMaxSize = size >= maxBatchSize;
  const hitMinAndTimeout = size >= minBatchSize && ageMs >= maxWaitTimeMs;
  const cleanupTimeout = size > 0 && ageMs >= cleanupWaitTimeMs && size < minBatchSize;

  if (!(hitMaxSize || hitMinAndTimeout || cleanupTimeout)) {
    return;
  }

  const jobsToProcess = standardBatchCollection;
  standardBatchCollection = [];
  standardBatchStartTimeMs = null;

  logger.info(
    {
      batch_size: jobsToProcess.length,
      reason: hitMaxSize ? 'maxBatchSize' : hitMinAndTimeout ? 'maxWaitTimeMs' : 'cleanupWaitTimeMs',
    },
    '[ARCHIVIST] Flushing STANDARD batch'
  );

  try {
    await processStandardBatch(logger, jobsToProcess);
  } catch (err) {
    logger.error({ err, batch_size: jobsToProcess.length }, '[ARCHIVIST] Error while processing STANDARD batch (placeholder)');
  }
}

/**
 * Try to flush batch collections by batch_id based on maxWaitTimeMs.
 *
 * @param {import('pino').Logger} logger
 */
async function maybeFlushBatchCollections(logger) {
  const now = Date.now();
  const { maxWaitTimeMs } = PROCESSING_CONFIG.batch;

  for (const [batchId, jobs] of batchCollectionsByBatchId.entries()) {
    const startTime = batchStartTimesByBatchId.get(batchId);
    if (!startTime) continue;

    const ageMs = now - startTime;

    if (ageMs >= maxWaitTimeMs && jobs.length > 0) {
      logger.info({ batch_id: batchId, job_count: jobs.length }, '[ARCHIVIST] Flushing BATCH group due to maxWaitTimeMs');

      batchCollectionsByBatchId.delete(batchId);
      batchStartTimesByBatchId.delete(batchId);

      try {
        await processBatchGroup(logger, batchId, jobs);
      } catch (err) {
        logger.error({ err, batch_id: batchId, job_count: jobs.length }, '[ARCHIVIST] Error while processing BATCH group (placeholder)');
      }
    }
  }
}

/**
 * Main polling loop for the archivist worker.
 * Priority order:
 * 1. INSTANT queue (single job)
 * 2. STANDARD queue (accumulate jobs for batching)
 * 3. BATCH queue (group by batch_id)
 *
 * This replicates the old behavior but with a cleaner architecture.
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

    // 2) STANDARD queue: process one job per loop (placeholder standard)
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

    // 3) BATCH queue: group by batch_id
    try {
      const batchJob = await batchQueue.dequeue();
      if (batchJob) {
        didWork = true;
        const batchId = batchJob.batch_id || 'unknown';

        logger.debug({ tenant_id: batchJob.tenant_id, asset_id: batchJob.asset_id, ai_description_id: batchJob.ai_description_id, batch_id: batchId }, '[ARCHIVIST] Dequeued BATCH job');

        // Directly hand off to batch/jobgroup processor (no accumulation)
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

    // Flush functions removed in favor of immediate processing (placeholders)

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
