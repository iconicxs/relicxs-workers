#!/usr/bin/env node
require('../src/module-aliases');

const path = require('path');
const os = require('os');
const fse = require('fs-extra');
const OpenAI = require('openai');
const config = require('@config');
const { logger } = require('@core/logger');
const { supabase } = require('../src/core/supabase');
const { runJobgroupArchivist } = require('../src/workers/archivist/archivist.batch');
const { fileExists } = require('../src/core/storage');

async function createJobgroupCLI(tenantId, batchId, mode) {
  const validModes = new Set(['instant', 'standard', 'jobgroup']);
  if (!validModes.has(mode)) {
    throw new Error(`Invalid mode: ${mode}`);
  }

  // Fetch assets in batch
  const { data: assets, error } = await supabase
    .from('asset')
    .select('id, tenant_id, batch_id')
    .eq('tenant_id', tenantId)
    .eq('batch_id', batchId);
  if (error) throw new Error(`[CLI][JOBGROUP] Failed to fetch assets: ${error.message}`);

  if (!assets || !assets.length) {
    console.log('No assets found for tenant/batch');
    return;
  }

  const jobs = [];
  for (const a of assets) {
    const aiKey = `standard/tenant-${tenantId}/asset-${a.id}/ai/ai_version.jpg`;
    const viewingKey = `standard/tenant-${tenantId}/asset-${a.id}/viewing/viewing.jpg`;
    let imagePath = null;
    try {
      const hasAi = await fileExists(config.b2.processedStandardBucketId, aiKey).catch(() => false);
      if (hasAi) imagePath = aiKey; else {
        const hasViewing = await fileExists(config.b2.processedStandardBucketId, viewingKey).catch(() => false);
        if (hasViewing) imagePath = viewingKey;
      }
    } catch (_) {}
    if (!imagePath) continue;

    const image_url = imagePath; // Assuming downstream will resolve to full URL or storage resolver
    jobs.push({ tenant_id: tenantId, batch_id: batchId, asset_id: a.id, image_url });
  }

  if (!jobs.length) {
    console.log('No eligible assets with images found.');
    return;
  }

  const workDir = path.join(os.tmpdir(), `archivist-jobgroup-${tenantId}-${Date.now()}`);
  fse.ensureDirSync(workDir);
  const res = await runJobgroupArchivist({ logger, jobs, workDir });
  console.log('jobgroup_id:', res.jobgroup_id);
  console.log('openai_batch_id:', res.openai_batch_id);
  console.log('input_file_id:', res.input_file_id);
  console.log('requestsCount:', res.requestsCount);
}

async function listJobgroupsCLI() {
  const { data, error } = await supabase
    .from('jobgroups')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(`[CLI][JOBGROUP] list failed: ${error.message}`);
  if (!data || !data.length) return console.log('No jobgroups.');
  for (const jg of data) {
    console.log(
      [jg.id, jg.tenant_id, jg.batch_id, jg.status, jg.openai_batch_id, jg.request_count, jg.created_at].join('\t')
    );
  }
}

async function showJobgroupCLI(id) {
  const { data: jg, error } = await supabase.from('jobgroups').select('*').eq('id', id).single();
  if (error) throw new Error(`[CLI][JOBGROUP] show failed: ${error.message}`);
  console.log('Jobgroup:', jg);
  const { data: results, error: e2 } = await supabase
    .from('jobgroup_results')
    .select('*')
    .eq('jobgroup_id', id)
    .order('completed_at', { ascending: false });
  if (e2) throw new Error(`[CLI][JOBGROUP] fetching results failed: ${e2.message}`);
  for (const r of results || []) {
    console.log([r.asset_id, r.status, r.error_code || '', r.error_message || ''].join('\t'));
  }
}

async function cancelJobgroupCLI(id) {
  const { data: jg, error } = await supabase.from('jobgroups').select('*').eq('id', id).single();
  if (error) throw new Error(`[CLI][JOBGROUP] fetch failed: ${error.message}`);
  if (!jg.openai_batch_id) throw new Error('Jobgroup has no openai_batch_id');
  const client = new OpenAI({ apiKey: config.openai.apiKey });
  await client.batches.cancel(jg.openai_batch_id);
  const notes = Object.assign({}, jg.notes || {}, { cancelled_at: new Date().toISOString(), cancelled_by: 'cli' });
  const { error: e2 } = await supabase.from('jobgroups').update({ status: 'cancelled', notes }).eq('id', id);
  if (e2) throw new Error(`[CLI][JOBGROUP] update failed: ${e2.message}`);
  console.log('Cancelled jobgroup:', id);
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd) {
    console.log('Usage: node scripts/jobgroup-cli.js <command> [...]');
    process.exit(1);
  }
  if (cmd === 'create-jobgroup') {
    const tenant = process.argv[3];
    const batch = process.argv[4];
    const mode = process.argv[5];
    if (!tenant || !batch || !mode) {
      console.log('Usage: node scripts/jobgroup-cli.js create-jobgroup <tenant_id> <batch_id> <mode>');
      process.exit(1);
    }
    await createJobgroupCLI(tenant, batch, mode);
  } else if (cmd === 'list-jobgroups') {
    await listJobgroupsCLI();
  } else if (cmd === 'show-jobgroup') {
    const id = process.argv[3];
    if (!id) { console.log('Usage: node scripts/jobgroup-cli.js show-jobgroup <jobgroup_id>'); process.exit(1); }
    await showJobgroupCLI(id);
  } else if (cmd === 'cancel-jobgroup') {
    const id = process.argv[3];
    if (!id) { console.log('Usage: node scripts/jobgroup-cli.js cancel-jobgroup <jobgroup_id>'); process.exit(1); }
    await cancelJobgroupCLI(id);
  } else {
    console.log('Unknown command:', cmd);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
