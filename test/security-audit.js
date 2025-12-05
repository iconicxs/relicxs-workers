#!/usr/bin/env node
require('dotenv').config();
const assert = require('assert');
const { ValidationError } = require('../src/errors/ValidationError');
const { sanitizeFilename, sanitizeExt } = require('../src/security/sanitize');
const { sendToDLQ } = require('../src/resilience/dlq');
const { getRedisClient } = require('../src/core/redis');

(async () => {
  try {
    // Invalid UUID job rejected
    const badJob = { tenant_id: 'not-a-uuid', asset_id: 'also-bad', job_type: 'image_processing' };
    const { validateMachinistJob } = require('../src/workers/machinist/machinist.utils');
    let threw = false;
    try { validateMachinistJob(badJob); } catch (e) { threw = e instanceof ValidationError; }
    assert.strictEqual(threw, true, 'Invalid UUID should throw ValidationError');

    // Unsafe filename rejected
    assert.strictEqual(sanitizeFilename('../evil.jpg'), '', 'Traversal must be rejected');
    assert.strictEqual(sanitizeFilename('ok-name.jpg') !== '', true, 'Safe filename accepted');

    // Extension whitelist
    assert.strictEqual(sanitizeExt('jpg') !== '', true, 'jpg allowed');
    assert.strictEqual(sanitizeExt('heic'), '', 'heic not allowed');

    // DLQ entry minimal fields
    const job = { tenant_id: '00000000-0000-4000-8000-000000000000', asset_id: '00000000-0000-4000-8000-000000000001', job_type: 'test_sec' };
    await sendToDLQ(job, 'test reason');
    const redis = await getRedisClient();
    const items = await redis.lRange('dlq:test_sec', 0, -1);
    assert.ok(items.length > 0, 'DLQ should have entries');
    const parsed = JSON.parse(items[items.length - 1]);
    assert.ok(parsed.id && parsed.timestamp && parsed.job_type, 'DLQ entry fields present');
    assert.ok(!parsed.payload || (!parsed.payload.image && !parsed.payload.buffer), 'DLQ payload should be safe');

    console.log('PASS: security audit');
    process.exit(0);
  } catch (err) {
    console.error('FAIL:', err);
    process.exit(1);
  }
})();
