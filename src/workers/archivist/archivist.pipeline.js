/**
 * Archivist pipeline: download image, build prompt, call OpenAI, normalize, upsert.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const fse = require('fs-extra');
const { downloadFile } = require('../../core/storage');
const config = require('../../core/config');
const { buildMessages, ALLOWED_TAGS } = require('./archivist.prompt');
const { runArchivistChat } = require('./archivist.openai');
const { upsertAiDescription, updateAiDescriptionNotes } = require('./archivist.db');
const { runJobgroupArchivist } = require('./archivist.batch');
const wrap = require('../../errors/wrap');
const { withRetry } = require('../../resilience/retry');
const { sanitizeString, sanitizeJson } = require('../../security/sanitize');
const LIMITS = require('@safety/runtime-limits');
const ValidationError = require('@errors/ValidationError');

function createWorkDir(tenantId, assetId) {
  const dir = path.join(os.tmpdir(), `archivist-${tenantId}-${assetId}-${Date.now()}`);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (_) { fse.ensureDirSync(dir); }
  return dir;
}

function safeJsonParse(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  // Strip markdown code fences
  s = s.replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
  // Extract JSON object
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end !== -1) s = s.slice(start, end + 1);
  // Remove trailing commas
  s = s.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(s); } catch (e) { return null; }
}

function normalizeStringArray(arr, limit) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const v of arr) {
    if (typeof v === 'string') out.push(v.trim());
    if (limit && out.length >= limit) break;
  }
  return out;
}

function normalizeTags(tags) {
  const arr = normalizeStringArray(tags);
  const set = new Set(ALLOWED_TAGS);
  return arr.filter((t) => set.has(t));
}

function buildThemesFromTags(tags) {
  return tags.map((t) => ({ theme_id: t, value: true }));
}

/**
 * Run archivist pipeline for a single job.
 * @param {import('pino').Logger} logger
 * @param {object} job
 */
async function runArchivistPipeline(logger, job) {
  if (os.freemem() / (1024 * 1024) < LIMITS.MIN_FREE_MEMORY_MB) {
    throw new Error('Insufficient free memory to safely process asset');
  }
  if (config.dryRun) {
    logger.warn(`[DRY_RUN] Archivist pipeline skipped for asset ${job.asset_id}`);
    return { dryRun: true, ai: { title: 'DRY RUN', description: 'No OpenAI call' } };
  }
  const start = Date.now();
  const tenantId = job.tenant_id;
  const assetId = job.asset_id;

  const workDir = createWorkDir(tenantId, assetId);
  const aiKey = `standard/tenant-${tenantId}/asset-${assetId}/ai/ai_version.jpg`;
  const viewingKey = `standard/tenant-${tenantId}/asset-${assetId}/viewing/viewing.jpg`;
  const inputPath = path.join(workDir, 'input.jpg');

  try {
    // Enforce processing_type known values at pipeline entry
    const allowed = new Set(['instant', 'standard', 'batch', 'jobgroup']);
    if (job.processing_type && !allowed.has(String(job.processing_type).toLowerCase())) {
      throw new ValidationError('INVALID_PROCESSING_TYPE', 'processing_type', `Unsupported processing_type: ${job.processing_type}`);
    }

    // If misrouted as jobgroup, delegate to batch flow to avoid DLQ
    if (String(job.processing_type || '').toLowerCase() === 'jobgroup') {
      const res = await runJobgroupArchivist({ logger, jobs: [job], workDir });
      return res;
    }
    // Step 2 — Download input (AI version then viewing fallback)
    try {
      await wrap(() => withRetry(() => downloadFile(config.b2.processedStandardBucketId, aiKey, inputPath), { logger, maxRetries: 2, baseDelay: 500, context: { step: 'download-ai' } }), logger, { step: 'download-ai' });
    } catch (e) {
      logger.warn({ err: e }, '[ARCHIVIST] AI version not found, using viewing.jpg');
      await wrap(() => withRetry(() => downloadFile(config.b2.processedStandardBucketId, viewingKey, inputPath), { logger, maxRetries: 2, baseDelay: 500, context: { step: 'download-viewing' } }), logger, { step: 'download-viewing' });
    }

    // Step 3 — Build prompt with OpenAI-safe image buffer (resize/compress)
    const sharp = require('sharp');
    const OPENAI_MAX_BYTES = 10 * 1024 * 1024; // keep comfortably under hard limit
    let resized = await sharp(inputPath)
      .rotate()
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    let q = 80;
    while (resized.length > OPENAI_MAX_BYTES && q >= 40) {
      resized = await sharp(inputPath)
        .rotate()
        .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: q })
        .toBuffer();
      q -= 10;
    }
    const imageBase64 = resized.toString('base64');
    let messages = buildMessages({ job, imageBase64 });
    // Prevent prompt overflow: hard cap content array length defensively
    messages = messages.map((m) => ({
      ...m,
      content: Array.isArray(m.content) ? m.content.slice(0, LIMITS.OPENAI_MAX_TOKENS) : m.content,
    }));

    // Step 4 — Send to OpenAI (GPT-5)
    const { text, usage, model } = await wrap(() => withRetry(() => runArchivistChat({ messages }), { logger, maxRetries: 2, baseDelay: 500, context: { step: 'openai' } }), logger, { step: 'openai' });

    // Guard AI output size
    const rawJson = text || '';
    const rawJsonBytes = Buffer.byteLength(rawJson, 'utf8');
    if (rawJsonBytes > LIMITS.OPENAI_MAX_JSON_BYTES) {
      throw new Error(`AI output exceeds ${LIMITS.OPENAI_MAX_JSON_BYTES} bytes`);
    }

    // Step 5 — Parse JSON safely
    const parsed = safeJsonParse(text) || {};

    // Step 6 — Build DB payload
    const tags = normalizeTags(parsed.tags);
    const keywords = normalizeStringArray(parsed.keywords, 30);
    const objects = normalizeStringArray(parsed.objects_identified);
    const expressions = normalizeStringArray(parsed.expressions_identified);
    const models = normalizeStringArray(parsed.models_identified);
    const spatial = parsed.spatial_coverage || {};
    const coverage = {
      country: typeof spatial.country === 'string' ? spatial.country : null,
      city: typeof spatial.city === 'string' ? spatial.city : null,
    };
    const temporal = parsed.temporal_coverage || {};
    const temporalNorm = { period: typeof temporal.period === 'string' ? temporal.period : null };

    const payload = {
      tenant_id: tenantId,
      batch_id: job.batch_id || null,
      asset_id: assetId,
      title: sanitizeString(parsed.title || '', { max: 150 }) || null,
      alternative_title: sanitizeString(parsed.alternative_title || '', { max: 200 }) || null,
      description: sanitizeString(parsed.description || '', { max: 2500 }) || null,
      abstract: sanitizeString(parsed.abstract || '', { max: 400 }) || null,
      subject: sanitizeString(parsed.subject || '', { max: 200 }) || null,
      tags,
      keywords,
      creators: null,
      contributors: null,
      events: null,
      spatial_coverage: coverage,
      temporal_coverage: temporalNorm,
      themes: buildThemesFromTags(tags),
      objects_identified: objects,
      expressions_identified: expressions,
      models_identified: models.length ? models : null,
      creation_date: null,
      creation_location: null,
      notes: sanitizeJson({ processing: { start_time: new Date(start).toISOString() } }),
    };

    // Step 7 — Upsert into DB
    await upsertAiDescription(payload);

    // Step 8 — End timer
    const end = Date.now();
    const durationMs = end - start;

    // Step 9 — Final telemetry write
    const notes = {
      processing: {
        start_time: new Date(start).toISOString(),
        end_time: new Date(end).toISOString(),
        duration_ms: durationMs,
        model_used: model,
        prompt_tokens: usage.prompt_tokens || 0,
        completion_tokens: usage.completion_tokens || 0,
      },
      jobgroup_id: job.jobgroup_id || null,
    };
    await updateAiDescriptionNotes(tenantId, assetId, notes);

    return { status: 'complete' };
  } catch (err) {
    logger.error({ err, tenant_id: tenantId, asset_id: assetId }, '[ARCHIVIST] Pipeline failed');
    throw err;
  } finally {
    try { await fs.rm(workDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { runArchivistPipeline };
