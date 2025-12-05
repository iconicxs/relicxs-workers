const { supabase } = require('../src/core/supabase');

async function expectAssetVersions(assetId) {
  const { data, error } = await supabase.from('asset_versions').select('*').eq('asset_id', assetId);
  if (error) throw new Error(`[TEST][DB] asset_versions query failed: ${error.message}`);
  if (!data || !data.length) throw new Error(`[TEST][DB] No asset_versions found for ${assetId}`);
  return data;
}

async function expectAiDescription(tenantId, assetId) {
  const { data, error } = await supabase.from('ai_description').select('*').eq('tenant_id', tenantId).eq('asset_id', assetId).limit(1);
  if (error) throw new Error(`[TEST][DB] ai_description query failed: ${error.message}`);
  if (!data || !data.length) throw new Error(`[TEST][DB] No ai_description found for ${tenantId}/${assetId}`);
  return data[0];
}

module.exports = { expectAssetVersions, expectAiDescription };
