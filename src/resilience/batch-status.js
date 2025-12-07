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
    // Map to allowed batch.status: not_started | in_progress | complete | cancelled
    let status = 'not_started';
    if (total === 0) status = 'not_started';
    else if (success === total) status = 'complete';
    else status = 'in_progress';

    // Update batch table (schema uses 'batch')
    await supabase.from('batch').update({ status }).eq('id', batchId);
    logger.info({ batch_id: batchId, status }, '[BATCH] Updated status');
  } catch (err) {
    logger.error({ err }, '[BATCH] Failed to update batch status');
  }
}

module.exports = { updateBatchStatus };
