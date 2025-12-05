require('../src/module-aliases');
const { createClient } = require('@supabase/supabase-js');
const config = require('@config');
const cleanup = require('@archivist/jobgroup-cleanup');

async function main() {
  console.log('== jobgroup-cleanup-test ==');

  const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

  console.log('→ Creating old jobgroups...');
  const cutoff = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);

  const tenantId = process.env.TEST_TENANT_ID || '00000000-0000-4000-8000-000000000000';
  const batchId = process.env.TEST_BATCH_ID || '00000000-0000-4000-8000-000000000001';

  const { data: jg, error } = await supabase
    .from('jobgroups')
    .insert({
      tenant_id: tenantId,
      batch_id: batchId,
      status: 'completed',
      created_at: cutoff.toISOString(),
    })
    .select('*')
    .single();
  if (error) throw error;

  const { error: e2 } = await supabase.from('jobgroup_results').insert({
    jobgroup_id: jg.id,
    tenant_id: tenantId,
    asset_id: null,
    status: 'completed',
    created_at: cutoff.toISOString(),
  });
  if (e2) throw e2;

  console.log('→ Running cleanup...');
  await cleanup();

  const { data: stillThere } = await supabase
    .from('jobgroup_results')
    .select('*')
    .eq('jobgroup_id', jg.id);

  if (stillThere && stillThere.length !== 0) throw new Error('jobgroup_results not deleted');

  console.log('PASS: jobgroup-cleanup-test');
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
