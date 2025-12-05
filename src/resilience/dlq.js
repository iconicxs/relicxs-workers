/**
 * Dead-letter queue helper
 */
const { getRedisClient } = require('../core/redis');
const { supabase } = require('../core/supabase');
const ValidationError = require('@errors/ValidationError');
const config = require('@config');
const crypto = require('crypto');
const { logger } = require('@core/logger');
const { dlqFailures } = require('../metrics/prometheus');
const fetch = require('node-fetch');

async function sendToDLQ(job, reason, log = logger) {
  const jobType = job && (job.job_type || job.jobType || 'unknown');
  const key = `dlq:${jobType}`;
  const client = await getRedisClient();
  try {
    const id = `dlq:${jobType}:${new Date().toISOString()}:${crypto.randomBytes(2).toString('hex')}`;
    const payload = {
      id,
      job_type: jobType,
      reason,
      code: job && job.code ? job.code : undefined,
      field: job && job.field ? job.field : undefined,
      timestamp: new Date().toISOString(),
      payload: { tenant_id: job && job.tenant_id, asset_id: job && job.asset_id, batch_id: job && job.batch_id, job_type: jobType },
    };
    await client.rPush(key, JSON.stringify(payload));
    log.warn({ tenant_id: job && job.tenant_id, asset_id: job && job.asset_id, batch_id: job && job.batch_id, reason }, '[DLQ] Sent job to DLQ');
    try {
      const worker = (jobType && String(jobType).split('.')[0]) || 'unknown';
      const reasonLabel = String(reason || 'unknown').slice(0, 80);
      dlqFailures.labels(worker, reasonLabel).inc();
    } catch (_) {}
  } catch (err) {
    log.error({ err }, '[DLQ] Failed to push to DLQ');
  }

  // If job has asset_id, try to write failed_reason to asset_versions (best-effort)
  try {
    if (job && job.asset_id) {
      if (config.dryRun || config.MINIMAL_MODE) {
        log.warn({ asset_id: job.asset_id }, '[DLQ] DRY_RUN/MINIMAL_MODE enabled — skipping DB failed_reason update');
      } else {
        await supabase.from('asset_versions').update({ failed_reason: reason }).eq('asset_id', job.asset_id);
        log.info({ asset_id: job.asset_id }, '[DLQ] Wrote failed_reason to asset_versions');
      }
    }
  } catch (err) {
    log.warn({ err }, '[DLQ] Failed to update DB failed_reason');
  }

  // Optional webhook notification for DLQ events
  try {
    const url = process.env.DLQ_WEBHOOK_URL || null;
    if (url) {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'dlq_event',
          job_type: job && (job.job_type || job.jobType || 'unknown'),
          tenant_id: job && job.tenant_id,
          asset_id: job && job.asset_id,
          batch_id: job && job.batch_id,
          reason,
          ts: Date.now(),
        })
      });
    }
  } catch (err) {
    logger.warn({ err }, '[DLQ] Webhook notify failed');
  }
}

module.exports = { sendToDLQ };
