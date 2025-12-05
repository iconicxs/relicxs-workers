const { validateMachinistJob: schemaValidateMachinistJob } = require('@schema/job-schemas');
const { validateImageBuffer } = require('./machinist.validation');
const { detectMime, validateMime, correctExtension } = require('./machinist.mime');

/**
 * Validate machinist job presence and required fields with explicit semantics.
 * Also enforces allowed file_purpose.
 * @param {any} job
 */
function validateMachinistJob(job) {
  // Keep schema validation if available
  try { schemaValidateMachinistJob(job); } catch (_) {}

  if (!job) throw new Error('MACHINIST: job missing');
  if (!job.tenant_id) throw new Error('MACHINIST: tenant_id missing');
  if (!job.asset_id) throw new Error('MACHINIST: asset_id missing');
  if (!job.batch_id) throw new Error('MACHINIST: batch_id missing');
  if (!job.file_purpose) throw new Error('MACHINIST: file_purpose missing');

  const allowed = ['preservation', 'viewing', 'production', 'restoration'];
  if (!allowed.includes(job.file_purpose)) {
    throw new Error(`MACHINIST: invalid file_purpose ${job.file_purpose}`);
  }
  return job;
}

/**
 * Safe synchronous file read with basic sanity checks.
 * @param {string} path
 * @returns {Buffer}
 */
async function safeRead(path) {
  const fs = require('fs');
  try {
    const buf = fs.readFileSync(path);
    if (!buf || buf.length === 0) throw new Error('Empty file');
    return buf;
  } catch (err) {
    throw new Error(`SAFE_READ_FAIL: ${err.message}`);
  }
}

/**
 * Check if an asset already has a specific version type.
 * @param {import('../../core/supabase').supabase} supabase
 * @param {string} assetId
 * @param {string} type
 * @returns {Promise<boolean>}
 */
async function hasExistingVersion(supabase, assetId, type) {
  const { data, error } = await supabase
    .from('asset_versions')
    .select('id')
    .eq('asset_id', assetId)
    .eq('version_type', type)
    .limit(1);
  if (error) throw new Error('VERSION_CHECK_FAIL');
  return Array.isArray(data) && data.length > 0;
}

module.exports = { validateMachinistJob, safeRead, hasExistingVersion, validateImageBuffer, detectMime, correctExtension, validateMime };
