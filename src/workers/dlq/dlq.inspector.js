/**
 * DLQ Inspector: CLI tool to inspect dead jobs.
 */
require('../../module-aliases');

const { initializeWorkerEnvironment } = require('../../startup/initialize');
const { getRedisClient } = require('../../core/redis');
const { DLQ_QUEUE } = require('./dlq.constants');
const { safeParseDLQ } = require('./dlq.parser');

async function startDLQInspector(logger) {
  const redis = await getRedisClient();

  const items = await redis.lRange(DLQ_QUEUE, 0, -1);

  logger.info({ count: items.length }, '[DLQ] Dead-letter queue contents');

  const parsed = items.map(safeParseDLQ);

  console.table(
    parsed.map((p) => ({
      error: p?.error,
      ts: p?.ts,
      job_asset: p?.job?.asset_id,
      job_tenant: p?.job?.tenant_id,
    }))
  );
}

(async () => {
  const { logger } = await initializeWorkerEnvironment({
    componentName: 'dlq-inspector',
  });
  await startDLQInspector(logger);
  process.exit(0);
})();
