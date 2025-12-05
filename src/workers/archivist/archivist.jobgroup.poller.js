const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const config = require('@config');
const { withRetry } = require('../../resilience/retry');
const {
  getActiveJobgroups,
  updateJobgroupStatus,
  upsertJobgroupResult,
  getAssetById,
  upsertAiDescription,
  hasJobgroupResult,
  getJobgroupResultsCount,
} = require('./archivist.db');
const { safeJsonParse, normalizeAiPayloadFromModel } = require('./archivist.utils');
const { emitJobgroupCompleted, emitJobgroupFailed } = require('@events/jobgroup.events');
const { writeJobgroupAudit } = require('@logs/jobgroup-logger');
const { withRedis } = require('../../core/redis');
const { sendToDLQ } = require('../../resilience/dlq');

// Adaptive polling: faster when there are active jobgroups, slower when idle
const ACTIVE_POLL_INTERVAL = parseInt(process.env.JOBGROUP_POLL_ACTIVE_INTERVAL_MS || process.env.JOBGROUP_POLL_INTERVAL_MS || '300000', 10); // default 5m
const IDLE_POLL_INTERVAL = parseInt(process.env.JOBGROUP_POLL_IDLE_INTERVAL_MS || '300000', 10); // default 5m
const POLLER_LOCK_KEY = 'jobgroup_poller_lock';
// Extended TTL to handle large output processing windows safely
const POLLER_LOCK_TTL_SEC = parseInt(process.env.JOBGROUP_POLL_LOCK_TTL_SEC || '900', 10);

/**
 * Acquire a distributed poller lock to ensure only one instance runs.
 * @returns {Promise<boolean>} true if lock acquired, false otherwise
 */
async function acquirePollerLock(logger) {
  try {
    const res = await withRedis((c) => c.set(POLLER_LOCK_KEY, String(Date.now()), { NX: true, EX: POLLER_LOCK_TTL_SEC }));
    const ok = res === 'OK';
    if (!ok) logger.debug('[JOBGROUP] Poller lock not acquired');
    return ok;
  } catch (err) {
    logger.warn({ err }, '[JOBGROUP] Failed to acquire poller lock; proceeding without lock');
    return true; // fail-open to avoid halting
  }
}

/**
 * Release the distributed poller lock.
 */
async function releasePollerLock(logger) {
  try {
    await withRedis((c) => c.del(POLLER_LOCK_KEY));
  } catch (err) {
    logger.warn({ err }, '[JOBGROUP] Failed to release poller lock');
  }
}

/**
 * Refresh the distributed poller lock TTL to prevent expiry mid-run.
 */
async function refreshPollerLock(logger) {
  try {
    await withRedis((c) => c.expire(POLLER_LOCK_KEY, POLLER_LOCK_TTL_SEC));
  } catch (err) {
    logger.warn({ err }, '[JOBGROUP] Failed to refresh poller lock');
  }
}

/**
 * Process a single output object from the OpenAI batch JSONL file.
 * Performs idempotency check and writes ai_description + jobgroup_results.
 * @param {any} obj Parsed JSONL line object
 * @param {any} jobgroup Jobgroup row
 * @param {import('pino').Logger} logger
 * @param {OpenAI | null} client
 * @returns {Promise<boolean>} true if processed, false if skipped
 */
async function processOneOutputObject(obj, jobgroup, logger, client) {
  try {
    const customId = obj.custom_id || '';
    const assetId = customId && customId.startsWith('asset-') ? customId.slice(6) : null;
    if (!assetId) return 'skipped';

    const already = await hasJobgroupResult(jobgroup.id, assetId);
    if (already) {
      logger.debug({ jobgroup_id: jobgroup.id, asset_id: assetId }, '[JOBGROUP] Skipping already-processed result');
      return 'skipped';
    }

    const asset = await getAssetById(assetId);
    const tenantId = asset.tenant_id;
    const batchId = asset.batch_id || null;

    let content = '';
    if (obj.response && obj.response.body && obj.response.body.choices && obj.response.body.choices[0]) {
      const msg = obj.response.body.choices[0].message && obj.response.body.choices[0].message.content;
      if (Array.isArray(msg)) content = msg.map((p) => (p.text || p)).join(' ');
      else content = String(msg || '');
    }

    const parsed = safeJsonParse(content) || {};
    const payload = normalizeAiPayloadFromModel(parsed, { tenantId, assetId, batchId });
    await upsertAiDescription(payload);

    await upsertJobgroupResult({
      jobgroupId: jobgroup.id,
      tenantId,
      assetId,
      batchId,
      customId,
      status: 'completed',
      rawResponse: obj,
      errorCode: null,
      errorMessage: null,
      startedAt: jobgroup.created_at || null,
      completedAt: new Date().toISOString(),
    });
    return 'processed';
  } catch (err) {
    logger.error({ err, jobgroup_id: jobgroup && jobgroup.id }, '[JOBGROUP] Failed to process output object');
    try {
      await upsertJobgroupResult({
        jobgroupId: jobgroup.id,
        tenantId: jobgroup.tenant_id || null,
        assetId: (obj && obj.custom_id && String(obj.custom_id).startsWith('asset-')) ? String(obj.custom_id).slice(6) : null,
        batchId: jobgroup.batch_id || null,
        customId: obj && obj.custom_id || null,
        status: 'failed',
        rawResponse: obj,
        errorCode: 'PROCESSING_FAILED',
        errorMessage: err && err.message ? err.message : String(err),
        startedAt: jobgroup.created_at || null,
        completedAt: new Date().toISOString(),
      });
    } catch (_) {}
    try {
      await sendToDLQ(
        { job_type: 'archivist.jobgroup-result', tenant_id: jobgroup.tenant_id || undefined, asset_id: (obj && obj.custom_id && String(obj.custom_id).startsWith('asset-')) ? String(obj.custom_id).slice(6) : undefined, batch_id: jobgroup.batch_id || undefined },
        'jobgroup_result_failed:' + (err && err.message ? err.message : String(err)),
        logger
      );
    } catch (_) {}
    return 'failed';
  }
}

async function processCompletedJobgroup(logger, client, jobgroup) {
  const outputId = jobgroup.output_file_id;
  if (!outputId) {
    logger.warn({ jobgroup_id: jobgroup.id }, '[JOBGROUP] Completed but no output_file_id');
    return;
  }
  let text;
  if (config.openaiMockDirectory) {
    const mockPath = path.join(config.openaiMockDirectory, `${outputId}.jsonl`);
    logger.info({ jobgroup_id: jobgroup.id, mockPath }, '[JOBGROUP] Reading output from mock file');
    text = fs.readFileSync(mockPath, 'utf8');
  } else {
    const res = await client.files.content(outputId);
    text = await res.text();
  }
  const lines = text.split('\n').filter(Boolean);
  const objects = lines.map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);

  // Jobgroup-level idempotency: if all results already exist, short-circuit
  try {
    const existingCount = await getJobgroupResultsCount(jobgroup.id);
    if (existingCount && existingCount === objects.length) {
      logger.info({ jobgroup_id: jobgroup.id, existingCount }, '[JOBGROUP] All results already present; completing');
      await updateJobgroupStatus(jobgroup.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        notes: { processed: existingCount, shortcut: 'already_complete' },
      });
      emitJobgroupCompleted(jobgroup);
      try { writeJobgroupAudit({ event: 'completed', jobgroup_id: jobgroup.id, processed: existingCount, shortcut: true }); } catch (_) {}
      return;
    }
  } catch (e) {
    logger.warn({ err: e, jobgroup_id: jobgroup.id }, '[JOBGROUP] Idempotency count check failed; proceeding');
  }

  // Chunk processing for concurrency control
  const chunkSize = 25;
  let processed = 0;
  let failed = 0;
  let skipped = 0;
  for (let i = 0; i < objects.length; i += chunkSize) {
    const chunk = objects.slice(i, i + chunkSize);
    const results = await Promise.allSettled(
      chunk.map((obj) => processOneOutputObject(obj, jobgroup, logger, client))
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (r.value === 'processed') processed += 1;
        else if (r.value === 'failed') failed += 1;
        else skipped += 1;
      } else {
        failed += 1;
      }
    }
    // keep the global poller lock alive while processing large batches
    await refreshPollerLock(logger);
  }

  if (failed > 0) {
    await updateJobgroupStatus(jobgroup.id, {
      status: 'failed',
      failed_at: new Date().toISOString(),
      notes: { processed, failed, skipped },
    });
    const updated = { ...jobgroup, status: 'failed' };
    emitJobgroupFailed(updated);
    try { writeJobgroupAudit({ event: 'failed', jobgroup_id: jobgroup.id, processed, failed, skipped }); } catch (_) {}
  } else {
    await updateJobgroupStatus(jobgroup.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      notes: { processed, skipped },
    });
    emitJobgroupCompleted(jobgroup);
    try { writeJobgroupAudit({ event: 'completed', jobgroup_id: jobgroup.id, processed, skipped }); } catch (_) {}
  }
}

// Returns true if any active jobgroups were found/processed
async function pollOnce(logger) {
  const gotLock = await acquirePollerLock(logger);
  if (!gotLock) return;
  try {
    // DRY RUN: skip all work
    if (config.dryRun) {
      logger.warn('[DRY_RUN] Poller skipped — dry-run mode.');
      return;
    }

    // MOCK MODE: never call OpenAI, require output_file_id
    if (config.openaiMockDirectory) {
      const active = await getActiveJobgroups();
      if (!active.length) return false;
      logger.info({ count: active.length }, '[JOBGROUP] MOCK: Processing active jobgroups');
      for (const jg of active) {
        if (!jg.output_file_id) {
          await updateJobgroupStatus(jg.id, { status: 'failed', notes: { mock_no_output_file: true } });
          continue;
        }
        await processCompletedJobgroup(logger, null, jg);
      }
      return true;
    }

    // REAL MODE: check OpenAI batch status
    const client = new OpenAI({ apiKey: config.openai.apiKey });
    const active = await getActiveJobgroups();
    if (!active.length) return false;
    logger.info({ count: active.length }, '[JOBGROUP] Polling active jobgroups');

    for (const jg of active) {
      const batch = await client.batches.retrieve(jg.openai_batch_id);
      if (batch.status === 'completed') {
        // persist output file id only; mark completed after processing
        await updateJobgroupStatus(jg.id, { output_file_id: batch.output_file_id });
        await processCompletedJobgroup(logger, client, { ...jg, output_file_id: batch.output_file_id });
      } else if (batch.status === 'failed' || batch.status === 'expired') {
        const updated = await updateJobgroupStatus(jg.id, { status: 'failed', failed_at: new Date().toISOString(), notes: { batch } });
        emitJobgroupFailed(updated);
        try { writeJobgroupAudit({ event: 'failed', jobgroup_id: jg.id, reason: 'batch failed or expired' }); } catch (_) {}
      } else {
        await updateJobgroupStatus(jg.id, { status: 'in_progress' });
      }
    }
    return true;
  } finally {
    await releasePollerLock(logger);
  }
}

function startJobgroupPolling(logger) {
  const scheduleNext = async (prevHadActive) => {
    const delay = prevHadActive ? ACTIVE_POLL_INTERVAL : IDLE_POLL_INTERVAL;
    setTimeout(async () => {
      let hadActive = false;
      try {
        const res = await pollOnce(logger);
        hadActive = !!res;
      } catch (e) {
        logger.error({ e }, '[JOBGROUP] periodic poll failed');
      } finally {
        scheduleNext(hadActive);
      }
    }, delay);
  };

  // Kick off initial poll, then schedule based on result
  (async () => {
    let hadActive = false;
    try {
      const res = await pollOnce(logger);
      hadActive = !!res;
    } catch (e) {
      logger.error({ e }, '[JOBGROUP] initial poll failed');
    } finally {
      scheduleNext(hadActive);
    }
  })();
}

module.exports = { pollOnce, startJobgroupPolling };