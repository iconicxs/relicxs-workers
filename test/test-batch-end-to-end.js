#!/usr/bin/env node
require('dotenv').config();
const path = require('path');
const { spawn } = require('child_process');
const { makeIds, createFixtureImage, buildMachinistJob, buildArchivistJob } = require('./faker-job-builder');
const { uploadFile } = require('../src/core/storage');
const config = require('../src/core/config');
const { assertViewingPaths } = require('./validate-storage');
const { expectAssetVersions, expectAiDescription } = require('./validate-db');

(async () => {
  const baseIds = makeIds();
  const assets = [makeIds(), makeIds(), makeIds()].map((a, i) => ({ ...a, tenant_id: baseIds.tenant_id, batch_id: baseIds.batch_id }));

  console.log('[TEST] Starting workers...');
  const mach = spawn('node', [path.join(__dirname, '../src/workers/machinist/machinist.worker.js')], { stdio: 'inherit' });
  const arch = spawn('node', [path.join(__dirname, '../src/workers/archivist/archivist.worker.js')], { stdio: 'inherit' });

  const { standardQueue: machStandard } = require('../src/queues/machinist');

  // Upload fixtures and enqueue machinist jobs as viewing
  for (const ids of assets) {
    const ext = 'jpg';
    const landingKey = `landing/tenant-${ids.tenant_id}/batch-${ids.batch_id}/asset-${ids.asset_id}/original.${ext}`;
    const fixture = await createFixtureImage();
    await uploadFile(config.b2.processedStandardBucketId, landingKey, fixture, 'image/jpeg');
    const job = buildMachinistJob({ ids, purpose: 'viewing', ext });
    await machStandard.enqueue(job);
  }

  const deadline1 = Date.now() + 180000;
  for (const ids of assets) {
    let done = false;
    while (Date.now() < deadline1) {
      try { await assertViewingPaths(ids.tenant_id, ids.asset_id, 'jpg'); await expectAssetVersions(ids.asset_id); done = true; break; } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
    }
    if (!done) throw new Error(`Machinist did not finish for ${ids.asset_id}`);
  }

  // Enqueue archivist jobs
  const { instantQueue } = require('../src/queues/archivist');
  for (const ids of assets) {
    const aJob = buildArchivistJob({ ids });
    await instantQueue.enqueue(aJob);
  }

  const deadline2 = Date.now() + 180000;
  for (const ids of assets) {
    let done = false;
    while (Date.now() < deadline2) {
      try { await expectAiDescription(ids.tenant_id, ids.asset_id); done = true; break; } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
    }
    if (!done) throw new Error(`Archivist did not finish for ${ids.asset_id}`);
  }

  mach.kill('SIGTERM');
  arch.kill('SIGTERM');

  console.log('PASS: batch end-to-end');
  process.exit(0);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
