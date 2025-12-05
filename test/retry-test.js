#!/usr/bin/env node
const { withRetry } = require('../src/resilience/retry');

let calls = 0;
async function unreliable() {
  calls += 1;
  if (calls < 3) throw new Error('transient');
  return 'ok';
}

(async () => {
  try {
    const res = await withRetry(() => unreliable(), { maxRetries: 5, baseDelay: 100, logger: console });
    if (res !== 'ok') throw new Error('unexpected result');
    console.log('PASS: retry test');
    process.exit(0);
  } catch (err) {
    console.error('FAIL:', err);
    process.exit(1);
  }
})();
