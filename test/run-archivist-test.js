#!/usr/bin/env node
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { instantQueue } = require('../src/queues/archivist');
const { makeIds, buildArchivistJob, createFixtureImage } = require('./faker-job-builder');
const { uploadFile } = require('../src/core/storage');
const config = require('../src/core/config');
const { expectAiDescription } = require('./validate-db');

(async () => {
  const ids = makeIds();
  const viewingKey = `standard/tenant-${ids.tenant_id}/asset-${ids.asset_id}/viewing/viewing.jpg`;

  const fixture = await createFixtureImage(1200, 800);
  await uploadFile(config.b2.processedStandardBucketId, viewingKey, fixture, 'image/jpeg');

  console.log('[TEST] Starting archivist worker...');
  const worker = spawn('node', [path.join(__dirname, '../src/workers/archivist/archivist.worker.js')], { stdio: 'inherit' });

  const job = buildArchivistJob({ ids });
  console.log('[TEST] Enqueue archivist job');
  await instantQueue.enqueue(job);

  const deadline = Date.now() + 180000; // 3 minutes
  let passed = false;
  while (Date.now() < deadline) {
    try {
      const row = await expectAiDescription(ids.tenant_id, ids.asset_id);
      if (!row.notes || !row.notes.processing) throw new Error('Telemetry notes missing');
      if (Array.isArray(row.tags) && row.tags.length > 0 && row.tags.some(t => typeof t !== 'string')) throw new Error('Tags not normalized');
      if (Array.isArray(row.keywords) && row.keywords.length > 30) throw new Error('Keywords exceed 30');
      passed = true;
      break;
    } catch (e) {
      console.log('[TEST] Waiting for archivist...', e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  worker.kill('SIGTERM');

  if (!passed) { console.error('FAIL: archivist pipeline'); process.exit(1); }
  console.log('PASS: archivist pipeline');
  process.exit(0);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
