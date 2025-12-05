// FULL E2E JOBGROUP TEST — SUCCESS PATH
// Uses OPENAI_MOCK_DIR to simulate OpenAI Batch output

process.env.NODE_ENV = 'test';
process.env.OPENAI_MOCK_DIR = __dirname; // Enable mock mode

require('../src/module-aliases');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { supabase } = require('@core/supabase');
const config = require('@config');
const { logger } = require('@core/logger');

const { runJobgroupArchivist } = require('@archivist/archivist.batch');
const { pollOnce } = require('../src/workers/archivist/archivist.jobgroup.poller');

(async () => {
  console.log('\n===== JOBGROUP SUCCESS E2E TEST START =====\n');

  const testLogger = logger.child({ test: 'jobgroup-success' });

  // 1) Create fake tenant + batch
  const tenantId = process.env.TEST_TENANT_ID || crypto.randomUUID();
  const batchId = process.env.TEST_BATCH_ID || crypto.randomUUID();

  // Optional inserts for tenant/batch if your schema requires them
  try { await supabase.from('tenant').insert({ id: tenantId, name: 'Test Tenant' }); } catch (_) {}
  try { await supabase.from('batch').insert({ id: batchId, tenant_id: tenantId, status: 'uploaded' }); } catch (_) {}

  // Create 3 fake assets
  const assets = [];
  for (let i = 0; i < 3; i++) {
    const assetId = crypto.randomUUID();
    assets.push(assetId);
    await supabase.from('asset').insert({
      id: assetId,
      tenant_id: tenantId,
      batch_id: batchId,
      original_filename: `test-${i}.jpg`,
      status: 'uploaded',
    });
  }

  console.log('✔ Inserted 3 fake assets');

  // 2) Build job list for JSONL builder
  const jobs = assets.map((aid) => ({
    tenant_id: tenantId,
    batch_id: batchId,
    asset_id: aid,
    image_url: `https://example.invalid/${aid}/viewing.jpg`,
  }));

  // 3) Start Jobgroup
  const wg = `/tmp/jobgroup-test-${Date.now()}`;
  fs.mkdirSync(wg, { recursive: true });

  const jobgroup = await runJobgroupArchivist({ logger: testLogger, jobs, workDir: wg });

  console.log('\n✔ Created jobgroup:', jobgroup.jobgroup_id);
  console.log('✔ OpenAI jobgroup id (mock):', jobgroup.openai_batch_id);

  // 4) Create mock output JSONL file named after output_file_id we will set
  const outputId = jobgroup.openai_batch_id;
  const outputFile = path.join(__dirname, `${outputId}.jsonl`);
  const jsonl = assets
    .map((aid) =>
      JSON.stringify({
        custom_id: `asset-${aid}`,
        response: {
          status_code: 200,
          body: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: `Mock Title ${aid}`,
                    alternative_title: 'Mock Alt',
                    description: 'Mock description.',
                    abstract: 'Mock abstract',
                    subject: 'Mock subject',
                    tags: ['fashion'],
                    keywords: ['mock'],
                    objects_identified: ['hat'],
                    actions_identified: [],
                    expressions_identified: [],
                    models_identified: [],
                    spatial_coverage_country: 'USA',
                    spatial_coverage_city: 'NYC',
                    temporal_coverage: '1960s',
                    temporal_coverage_start_date: null,
                    temporal_coverage_end_date: null,
                  }),
                },
              },
            ],
          },
        },
        error: null,
      })
    )
    .join('\n');

  fs.writeFileSync(outputFile, jsonl);
  console.log('✔ Created mock JSONL output:', outputFile);

  // 5) Patch jobgroup to mark output_file_id to our mock id
  await supabase
    .from('jobgroups')
    .update({ status: 'in_progress', output_file_id: outputId })
    .eq('id', jobgroup.jobgroup_id);

  // 6) Run poller
  console.log('\n✔ Running pollOnce...');
  await pollOnce(testLogger);

  // 7) Validate DB results
  const { data: results } = await supabase
    .from('jobgroup_results')
    .select('*')
    .eq('jobgroup_id', jobgroup.jobgroup_id);

  const { data: descriptions } = await supabase
    .from('ai_description')
    .select('*')
    .in('asset_id', assets);

  const { data: jobgroupRow } = await supabase
    .from('jobgroups')
    .select('*')
    .eq('id', jobgroup.jobgroup_id)
    .single();

  console.log('\n===== VALIDATION =====');
  console.log('jobgroup_results count:', results ? results.length : 0);
  console.log('ai_description count:', descriptions ? descriptions.length : 0);
  console.log('jobgroup status:', jobgroupRow ? jobgroupRow.status : '(missing)');

  if (!results || results.length !== 3) throw new Error('❌ jobgroup_results mismatch');
  if (!descriptions || descriptions.length !== 3) throw new Error('❌ ai_description mismatch');
  if (!jobgroupRow || jobgroupRow.status !== 'completed') throw new Error('❌ jobgroup not completed');

  // Verify asset ids match
  const descAssetIds = new Set(descriptions.map((d) => d.asset_id));
  for (const aid of assets) {
    if (!descAssetIds.has(aid)) throw new Error(`❌ Missing ai_description for asset ${aid}`);
  }

  console.log('\n🎉 JOBGROUP SUCCESS E2E TEST PASSED 🎉\n');
})().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
