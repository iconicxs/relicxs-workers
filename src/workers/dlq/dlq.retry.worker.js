require('../../module-aliases');

const { initializeWorkerEnvironment } = require('../../startup/initialize');
const { getRedisClient } = require('../../core/redis');
const {
  DLQ_QUEUE,
  DLQ_RETRY_QUEUE,
  DLQ_MAX_RETRIES,
  DLQ_RETRY_DELAY_MS,
} = require('./dlq.constants');
const { safeParseDLQ } = require('./dlq.parser');

/**
 * Retry worker for DLQ.
 * This worker reads dead jobs, checks retry count, and requeues them.
 */
async function startDLQRetryWorker(logger) {
  const redis = await getRedisClient();
  logger.info('[DLQ] DLQ Retry Worker Started');

  while (true) {
    try {
      const result = await redis.lPop(DLQ_QUEUE);

      if (!result) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      const parsed = safeParseDLQ(result);
      if (!parsed) {
        logger.error('[DLQ] Could not parse DLQ message — discarding.');
        continue;
      }

      parsed.retryCount = parsed.retryCount || 0;

      if (parsed.retryCount >= DLQ_MAX_RETRIES) {
        logger.error({ parsed }, '[DLQ] Max retries reached — permanently failed.');
        continue;
      }

      parsed.retryCount++;

      logger.warn(
        { job: parsed.job, retryCount: parsed.retryCount },
        '[DLQ] Retrying failed job'
      );

      // Delay before retry
      await new Promise((r) => setTimeout(r, DLQ_RETRY_DELAY_MS));

      // Requeue job to retry queue
      await redis.rPush(DLQ_RETRY_QUEUE, JSON.stringify(parsed));

    } catch (err) {
      logger.error({ err }, '[DLQ] Retry worker loop error');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

(async () => {
  try {
    const { logger } = await initializeWorkerEnvironment({
      componentName: 'dlq-retry-worker',
    });
    await startDLQRetryWorker(logger);
  } catch (err) {
    console.error('[DLQ] Fatal error during startup:', err);
    process.exit(1);
  }
})();
