const { PRIORITY } = require('../../jobs/job.priority');
const { validateArchivistJob: schemaValidateArchivistJob } = require('@schema/job-schemas');
const { ALLOWED_TAGS } = require('./archivist.prompt');

/**
 * Processing configuration mirroring the old worker behavior.
 */
const PROCESSING_CONFIG = {
  standard: {
    minBatchSize: 10,
    maxBatchSize: 50,
    maxWaitTimeMs: 2 * 60 * 1000, // 2 minutes
    cleanupWaitTimeMs: 30 * 1000, // 30 seconds
  },
  batch: {
    maxWaitTimeMs: 10 * 60 * 1000, // 10 minutes per batch_id
    pollingIntervalMs: 5 * 60 * 1000, // future: for batch status checks
  },
};

/**
 * @typedef {Object} AiAnalysisJob
 * @property {string} tenant_id
 * @property {string} asset_id
 * @property {string} ai_description_id
 * @property {string} [batch_id]
 * @property {string} [job_type] - should be JOB_TYPES.AI_ANALYSIS
 * @property {string} [processing_type] - 'individual' | 'standard' | 'batch'
 * @property {string} [storage_path]
 * @property {string} [created_by]
 * @property {string} [created_by_name]
 */

/**
 * Basic validation for archivist jobs.
 * @param {any} job
 * @returns {AiAnalysisJob}
 */
function validateArchivistJob(job) {
  return schemaValidateArchivistJob(job);
}

function safeJsonParse(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end !== -1) s = s.slice(start, end + 1);
  s = s.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(s); } catch { return null; }
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
  const set = new Set(ALLOWED_TAGS);
  return normalizeStringArray(tags).filter((t) => set.has(t));
}

function buildThemesFromTags(tags) {
  return tags.map((t) => ({ theme_id: t, value: true }));
}

function normalizeAiPayloadFromModel(parsed, { tenantId, assetId, batchId }) {
  const tags = normalizeTags(parsed && parsed.tags);
  const keywords = normalizeStringArray(parsed && parsed.keywords, 30);
  const objects = normalizeStringArray(parsed && parsed.objects_identified);
  const expressions = normalizeStringArray(parsed && parsed.expressions_identified);
  const models = normalizeStringArray(parsed && parsed.models_identified);
  const spatial = (parsed && parsed.spatial_coverage) || {};
  const coverage = {
    country: typeof spatial.country === 'string' ? spatial.country : null,
    city: typeof spatial.city === 'string' ? spatial.city : null,
  };
  const temporal = (parsed && parsed.temporal_coverage) || {};
  const temporalNorm = { period: typeof temporal.period === 'string' ? temporal.period : null };

  return {
    tenant_id: tenantId,
    batch_id: batchId || null,
    asset_id: assetId,
    title: (parsed && parsed.title) || null,
    alternative_title: (parsed && parsed.alternative_title) || null,
    description: (parsed && parsed.description) || null,
    abstract: (parsed && parsed.abstract) || null,
    subject: (parsed && parsed.subject) || null,
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
    notes: { processing: { source: 'jobgroup' } },
  };
}

module.exports = { PROCESSING_CONFIG, PRIORITY, validateArchivistJob, safeJsonParse, normalizeAiPayloadFromModel };
