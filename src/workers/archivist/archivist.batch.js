const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const config = require('@config');
const { PROCESSING_CONFIG, validateArchivistJob } = require('./archivist.utils');
const { pollOnce } = require('./archivist.jobgroup.poller');
const { buildJobgroupJsonlFile } = require('./jobgroup/jobgroup-jsonl-builder');
const { createJobgroup, getRecentJobgroupsForTenant } = require('./archivist.db');
const { emitJobgroupCreated } = require('@events/jobgroup.events');
const { writeJobgroupAudit } = require('@logs/jobgroup-logger');
const { recordJobStart, recordJobEnd } = require('../../job-system/metrics');
const { sendToDLQ } = require('../../resilience/dlq');
const { withRetry } = require('../../resilience/retry');
const { logger: rootLogger } = require('../../core/logger');
const { logStart, logEnd, logFailure } = require('../../resilience/logging');

/**
 * Create an OpenAI Batch (jobgroup) for a set of jobs.
 * @param {object} params
 * @param {import('pino').Logger} params.logger
 * @param {Array} params.jobs
 * @param {string} params.workDir
 */
async function runJobgroupArchivist({ logger, jobs, workDir }) {
  const validJobs = jobs.map(validateArchivistJob);
  logger.info(`Starting Archivist Jobgroup: ${validJobs.length} items`);

  if (config.dryRun) {
    logger.warn('[DRY_RUN] Skipping jobgroup creation');
    return {
      jobgroup_id: 'dry_jobgroup',
      openai_batch_id: 'dry_batch',
      input_file_id: 'dry_input',
      status: 'completed',
      requestsCount: jobs.length,
    };
  }

  // Throttling: block if tenant has active/too many recent jobgroups
  const tenantId = validJobs[0].tenant_id;
  const recent = await getRecentJobgroupsForTenant(tenantId);
  const active = recent.filter((j) => ['queued', 'in_progress', 'validating', 'created'].includes(j.status));
  if (active.length >= 1) {
    throw new Error('Too many jobgroups in progress. Please wait.');
  }
  const last24 = recent.filter((j) => Date.now() - new Date(j.created_at).getTime() < 24 * 60 * 60 * 1000);
  if (last24.length >= 5) {
    throw new Error('Rate limit: max 5 jobgroups in 24h reached');
  }

  // Ensure workDir exists (fallback to OS temp if not provided)
  const os = require('os');
  const p = require('path');
  const fs = require('fs');
  const tenantForDir = (validJobs[0] && validJobs[0].tenant_id) ? validJobs[0].tenant_id : 'tenant';
  const resolvedWorkDir = workDir || p.join(os.tmpdir(), `archivist-jobgroup-${tenantForDir}-${Date.now()}`);
  try { fs.mkdirSync(resolvedWorkDir, { recursive: true, mode: 0o700 }); } catch (_) {}

  const { jsonlPath, requestsCount } = await buildJobgroupJsonlFile({ jobs: validJobs, workDir: resolvedWorkDir });
  logger.info(`Created jobgroup JSONL with ${requestsCount} entries`);

  const client = new OpenAI({ apiKey: config.openai.apiKey });

  const inputFile = await client.files.create({
    file: fs.createReadStream(jsonlPath),
    purpose: 'batch',
  });

  // derive batch from first job (homogeneous group)
  const batchId = validJobs[0].batch_id || null;

  const jobgroup = await client.batches.create({
    input_file_id: inputFile.id,
    endpoint: '/v1/chat/completions',
    completion_window: '24h',
    metadata: { tenant_id: tenantId, batch_id: batchId, mode: 'jobgroup' },
  });

  logger.info(`Jobgroup created: ${jobgroup.id}`);
  // persist jobgroup metadata
  const created = await createJobgroup({
    tenantId,
    batchId,
    openaiBatchId: jobgroup.id,
    inputFileId: inputFile.id,
    status: jobgroup.status || 'created',
    requestCount: requestsCount,
    notes: { jsonlPath, workDir: resolvedWorkDir },
  });

  emitJobgroupCreated(created);
  try {
    writeJobgroupAudit({
      event: 'created',
      jobgroup_id: created.id,
      openai_batch_id: created.openai_batch_id,
    });
  } catch (_) {}

  // Kick the poller to reduce latency from idle state
  try { await pollOnce(logger); } catch (_) {}

  return { jobgroup_id: created.id, openai_batch_id: jobgroup.id, input_file_id: inputFile.id, status: jobgroup.status, requestsCount };
}

module.exports = { PROCESSING_CONFIG, runJobgroupArchivist };

/**
 * Metrics-wrapped batch jobgroup handler.
 * @param {import('pino').Logger} logger
 * @param {{ jobs: any[], workDir?: string, priority?: string, id?: string }} rawJobGroup
 */
async function processBatchArchivistJob(logger, rawJobGroup) {
  const job = { ...(rawJobGroup || {}), type: 'archivist.batch', priority: rawJobGroup?.priority || 'batch' };
  try { await recordJobStart(job); } catch (_) {}
  logStart(logger, job);
  try {
    const res = await withRetry(
      () => runJobgroupArchivist({ logger, jobs: rawJobGroup.jobs, workDir: rawJobGroup.workDir }),
      { logger, maxRetries: 2, baseDelay: 500, context: { step: 'archivist-batch' } }
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

module.exports.processBatchArchivistJob = processBatchArchivistJob;
