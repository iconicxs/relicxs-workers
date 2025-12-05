#!/usr/bin/env node
require('dotenv').config();
const { sendToDLQ } = require('../src/resilience/dlq');
const { getRedisClient } = require('../src/core/redis');

(async () => {
  const job = { tenant_id: 't-test', asset_id: 'a-test', job_type: 'test_job' };
  const reason = 'unit test failure';
  try {
    await sendToDLQ(job, reason);
    const redis = await getRedisClient();
    const list = await redis.lRange('dlq:test_job', 0, -1);
    if (!list || !list.length) throw new Error('DLQ empty');
    console.log('DLQ entry:', list[list.length - 1]);
    console.log('PASS: dlq test');
    process.exit(0);
  } catch (err) {
    console.error('FAIL:', err);
    process.exit(1);
  }
})();
