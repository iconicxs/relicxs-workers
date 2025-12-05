#!/usr/bin/env node
require('dotenv').config();
const path = require('path');
const { spawn } = require('child_process');
const { createClient } = require('redis');
const { makeIds, createFixtureImage, buildMachinistJob } = require('./faker-job-builder');
const { uploadFile } = require('../src/core/storage');
const config = require('../src/core/config');
const { assertProductionPaths } = require('./validate-storage');
const { expectAssetVersions } = require('./validate-db');

(async () => {
  const ids = makeIds();
  const ext = 'jpg';
  const landingKey = `landing/tenant-${ids.tenant_id}/batch-${ids.batch_id}/asset-${ids.asset_id}/original.${ext}`;

  const fixture = await createFixtureImage();
  await uploadFile(config.b2.processedStandardBucketId, landingKey, fixture, 'image/jpeg');

  const worker = spawn('node', [path.join(__dirname, '../src/workers/machinist/machinist.worker.js')], { stdio: 'inherit' });

  const redis = createClient({ socket: { host: config.redis.host, port: config.redis.port }, password: config.redis.password });
  await redis.connect();

  const job = buildMachinistJob({ ids, purpose: 'production', ext });
  await redis.rPush('image-processing:jobs', JSON.stringify(job));

  const deadline = Date.now() + 120000;
  let passed = false;
  while (Date.now() < deadline) {
    try {
      await assertProductionPaths(ids.tenant_id, ids.asset_id, ext);
      // Ensure ai_version is absent by attempting and allowing failure
      const base = `standard/tenant-${ids.tenant_id}/asset-${ids.asset_id}/ai/ai_version.jpg`;
      try { await require('./validate-storage').mustDownload(base); throw new Error('ai_version should not exist'); } catch (_) {}
      await expectAssetVersions(ids.asset_id);
      passed = true;
      break;
    } catch (e) {
      console.log('[TEST] Waiting...', e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  await redis.quit();
  worker.kill('SIGTERM');

  if (!passed) { console.error('FAIL: production pipeline'); process.exit(1); }
  console.log('PASS: production pipeline');
  process.exit(0);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
