/**
 * Batch status updater
 */
const { supabase } = require('../core/supabase');
const { logger } = require('../core/logger');

async function updateBatchStatus(batchId) {
  if (!batchId) return;
  try {
    const { data: rows, error } = await supabase.from('asset_versions').select('status').eq('batch_id', batchId);
    if (error) throw error;
    const total = rows.length;
    const success = rows.filter((r) => r.status === 'success').length;
    const failed = rows.filter((r) => r.status === 'failed').length;
    let status = 'pending';
    if (total > 0 && success === total) status = 'complete';
    else if (failed > 0) status = 'failed_with_errors';

    const notes = { completed_at: new Date().toISOString(), total_assets: total, success, failed };
    await supabase.from('batches').update({ status, notes }).eq('id', batchId);
    logger.info({ batch_id: batchId, status }, '[BATCH] Updated status');
  } catch (err) {
    logger.error({ err }, '[BATCH] Failed to update batch status');
  }
}

module.exports = { updateBatchStatus };
