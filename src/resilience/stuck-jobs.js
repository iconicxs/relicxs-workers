/**
 * Detect and reset stuck jobs in asset_versions
 */
const { supabase } = require('../core/supabase');
const { logger } = require('../core/logger');

const THIRTY_MIN_MS = 30 * 60 * 1000;

async function detectAndResetStuckJobs() {
  const cutoff = new Date(Date.now() - THIRTY_MIN_MS).toISOString();
  const { data, error } = await supabase.from('asset_versions').select('*').eq('status', 'processing').lt('updated_at', cutoff);
  if (error) {
    logger.error({ err: error }, '[STUCK] Failed to query asset_versions');
    return;
  }
  for (const row of data || []) {
    try {
      await supabase.from('asset_versions').update({ status: 'pending', notes: 'reset_by_stuck_job_detector' }).eq('id', row.id);
      logger.warn({ id: row.id, asset_id: row.asset_id }, '[STUCK] Reset stuck asset_version to pending');
    } catch (err) {
      logger.error({ err }, '[STUCK] Failed to reset stuck job');
    }
  }
}

// Schedule every 10 minutes
setInterval(() => { detectAndResetStuckJobs().catch((e) => logger.error({ e }, '[STUCK] detector failed')); }, 10 * 60 * 1000);

module.exports = { detectAndResetStuckJobs };
