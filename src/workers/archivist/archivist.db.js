/**
 * Supabase DB helpers for ai_description upsert and telemetry.
 */
const { supabase } = require('../../core/supabase');

/**
 * Upsert ai_description by (tenant_id, asset_id).
 * @param {object} payload
 */
async function upsertAiDescription(payload) {
  const { data, error } = await supabase
    .from('ai_description')
    .upsert(payload, { onConflict: 'tenant_id,asset_id' })
    .select('*')
    .limit(1);
  if (error) throw new Error(`[ARCHIVIST][DB] Upsert failed: ${error.message}`);
  return data && data[0];
}

/**
 * Patch notes (telemetry) for an ai_description row.
 * @param {string} tenantId
 * @param {string} assetId
 * @param {object} notes
 */
async function updateAiDescriptionNotes(tenantId, assetId, notes) {
  const { error } = await supabase
    .from('ai_description')
    .update({ notes })
    .eq('tenant_id', tenantId)
    .eq('asset_id', assetId);
  if (error) throw new Error(`[ARCHIVIST][DB] Update notes failed: ${error.message}`);
}

module.exports = { upsertAiDescription, updateAiDescriptionNotes };

/**
 * Create a jobgroup record.
 */
async function createJobgroup({ tenantId, batchId, openaiBatchId, inputFileId, status, requestCount, notes }) {
  const payload = {
    tenant_id: tenantId,
    batch_id: batchId || null,
    openai_batch_id: openaiBatchId,
    input_file_id: inputFileId,
    status,
    request_count: requestCount || 0,
    notes: notes || null,
  };
  const { data, error } = await supabase.from('jobgroups').insert(payload).select('*').single();
  if (error) throw new Error(`[ARCHIVIST][DB] createJobgroup failed: ${error.message}`);
  return data;
}

/**
 * Update jobgroup status by id.
 */
async function updateJobgroupStatus(jobgroupId, patch) {
  const { data, error } = await supabase.from('jobgroups').update(patch).eq('id', jobgroupId).select('*').single();
  if (error) throw new Error(`[ARCHIVIST][DB] updateJobgroupStatus failed: ${error.message}`);
  return data;
}

/**
 * Get jobgroups that are not yet completed/failed.
 */
async function getActiveJobgroups() {
  const { data, error } = await supabase
    .from('jobgroups')
    .select('*')
    .in('status', ['created', 'in_progress', 'validating']);
  if (error) throw new Error(`[ARCHIVIST][DB] getActiveJobgroups failed: ${error.message}`);
  return data || [];
}

/**
 * Upsert a jobgroup result record for an asset.
 */
async function upsertJobgroupResult({ jobgroupId, tenantId, assetId, batchId, customId, status, rawResponse, errorCode, errorMessage, startedAt, completedAt }) {
  const payload = {
    jobgroup_id: jobgroupId,
    tenant_id: tenantId,
    asset_id: assetId,
    batch_id: batchId || null,
    custom_id: customId || null,
    status,
    raw_response: rawResponse || null,
    error_code: errorCode || null,
    error_message: errorMessage || null,
    started_at: startedAt || null,
    completed_at: completedAt || null,
  };
  const { data, error } = await supabase
    .from('jobgroup_results')
    .upsert(payload, { onConflict: 'jobgroup_id,asset_id' })
    .select('*')
    .single();
  if (error) throw new Error(`[ARCHIVIST][DB] upsertJobgroupResult failed: ${error.message}`);
  return data;
}

/**
 * Fetch asset by id.
 */
async function getAssetById(assetId) {
  const { data, error } = await supabase.from('asset').select('*').eq('id', assetId).single();
  if (error) throw new Error(`[ARCHIVIST][DB] getAssetById failed: ${error.message}`);
  return data;
}

module.exports.createJobgroup = createJobgroup;
module.exports.updateJobgroupStatus = updateJobgroupStatus;
module.exports.getActiveJobgroups = getActiveJobgroups;
module.exports.upsertJobgroupResult = upsertJobgroupResult;
module.exports.getAssetById = getAssetById;

/**
 * Check if a jobgroup result already exists for a given asset.
 * @param {string} jobgroupId
 * @param {string} assetId
 * @returns {Promise<boolean>}
 */
async function hasJobgroupResult(jobgroupId, assetId) {
  const { data, error } = await supabase
    .from('jobgroup_results')
    .select('asset_id')
    .eq('jobgroup_id', jobgroupId)
    .eq('asset_id', assetId)
    .limit(1);
  if (error) throw new Error(`[ARCHIVIST][DB] hasJobgroupResult failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

module.exports.hasJobgroupResult = hasJobgroupResult;

/**
 * Get recent jobgroups (limit 50) for throttling decisions for a tenant.
 */
async function getRecentJobgroupsForTenant(tenantId) {
  const { data, error } = await supabase
    .from('jobgroups')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(`[ARCHIVIST][DB] getRecentJobgroupsForTenant failed: ${error.message}`);
  return data || [];
}

module.exports.getRecentJobgroupsForTenant = getRecentJobgroupsForTenant;

/**
 * Get count of results for a jobgroup.
 * @param {string} jobgroupId
 * @returns {Promise<number>}
 */
async function getJobgroupResultsCount(jobgroupId) {
  const { count, error } = await supabase
    .from('jobgroup_results')
    .select('asset_id', { count: 'exact', head: true })
    .eq('jobgroup_id', jobgroupId);
  if (error) throw new Error(`[ARCHIVIST][DB] getJobgroupResultsCount failed: ${error.message}`);
  return count || 0;
}

module.exports.getJobgroupResultsCount = getJobgroupResultsCount;
