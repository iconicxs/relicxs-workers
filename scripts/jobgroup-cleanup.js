#!/usr/bin/env node
require('../src/module-aliases');

const { supabase } = require('../src/core/supabase');

async function main() {
  const days = parseInt(process.env.JOBGROUP_RETENTION_DAYS || '30', 10);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data: groups, error } = await supabase
    .from('jobgroups')
    .select('id, created_at, status, notes')
    .lt('created_at', cutoff)
    .in('status', ['completed', 'failed', 'expired', 'cancelled']);
  if (error) throw new Error(`[CLEANUP] query failed: ${error.message}`);

  if (!groups || !groups.length) {
    console.log(`No jobgroups older than ${days} days.`);
    return;
  }

  let deletedResults = 0;
  for (const g of groups) {
    const { error: e1, count } = await supabase
      .from('jobgroup_results')
      .delete()
      .eq('jobgroup_id', g.id);
    if (e1) throw new Error(`[CLEANUP] delete results failed: ${e1.message}`);
    deletedResults += (count || 0);

    const notes = Object.assign({}, g.notes || {}, { cleaned_at: new Date().toISOString(), cleaned_by: 'jobgroup-cleanup' });
    const { error: e2 } = await supabase
      .from('jobgroups')
      .update({ notes })
      .eq('id', g.id);
    if (e2) throw new Error(`[CLEANUP] update jobgroup failed: ${e2.message}`);
  }

  console.log(`Found ${groups.length} jobgroups older than ${days} days`);
  console.log(`Deleted ${deletedResults} jobgroup_results`);
  console.log(`Updated ${groups.length} jobgroups`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
