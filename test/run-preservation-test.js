#!/usr/bin/env node
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { createClient } = require('redis');
const { makeIds, createFixtureImage, buildMachinistJob } = require('./faker-job-builder');
const { uploadFile } = require('../src/core/storage');
const config = require('../src/core/config');
const { assertPreservationPaths } = require('./validate-storage');
const { expectAssetVersions } = require('./validate-db');

(async () => {
  const ids = makeIds();
  const ext = 'jpg';
  const landingKey = `landing/tenant-${ids.tenant_id}/batch-${ids.batch_id}/asset-${ids.asset_id}/original.${ext}`;

  console.log('[TEST] Generating fixture image...');
  const fixture = await createFixtureImage();

  console.log('[TEST] Uploading to landing:', landingKey);
  await uploadFile(config.b2.processedStandardBucketId, landingKey, fixture, 'image/jpeg');

  console.log('[TEST] Starting machinist worker...');
  const worker = spawn('node', [path.join(__dirname, '../src/workers/machinist/machinist.worker.js')], { stdio: 'inherit' });

  const redis = createClient({ socket: { host: config.redis.host, port: config.redis.port }, password: config.redis.password });
  await redis.connect();

  const job = buildMachinistJob({ ids, purpose: 'preservation', ext });
  console.log('[TEST] Enqueue job:', job);
  await redis.rPush('image-processing:jobs', JSON.stringify(job));

  // Wait and validate
  const deadline = Date.now() + 120000; // 2 minutes
  let passed = false;
  while (Date.now() < deadline) {
    try {
      await assertPreservationPaths(ids.tenant_id, ids.asset_id, ext);
      await expectAssetVersions(ids.asset_id);
      passed = true;
      break;
    } catch (e) {
      console.log('[TEST] Waiting for pipeline...', e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  await redis.quit();
  worker.kill('SIGTERM');

  if (!passed) {
    console.error('FAIL: preservation pipeline validation did not pass in time');
    process.exit(1);
  }
  console.log('PASS: preservation pipeline validated');
  process.exit(0);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
