#!/usr/bin/env node
require('dotenv').config();
const { supabase } = require('../src/core/supabase');
const { detectAndResetStuckJobs } = require('../src/resilience/stuck-jobs');

(async () => {
  try {
    // Insert fake stuck row
    const assetId = `test-asset-${Date.now()}`;
    const now = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const { data, error } = await supabase.from('asset_versions').insert([{ asset_id: assetId, status: 'processing', updated_at: now }]);
    if (error) throw error;
    await detectAndResetStuckJobs();
    const { data: rows } = await supabase.from('asset_versions').select('*').eq('asset_id', assetId);
    if (!rows || !rows.length) throw new Error('no rows after insert');
    if (rows[0].status !== 'pending') throw new Error('status not reset');
    console.log('PASS: stuck jobs test');
    process.exit(0);
  } catch (err) { console.error('FAIL:', err); process.exit(1); }
})();
