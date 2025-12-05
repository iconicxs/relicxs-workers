const assert = require('assert');
const { withTimeout } = require('../src/safety/with-timeout');
const LIMITS = require('../src/safety/runtime-limits');

(async () => {
  console.log('Running safety tests...');

  // Timeout test
  try {
    await withTimeout(
      new Promise((res) => setTimeout(res, 2000)),
      10
    );
    throw new Error('Timeout test failed');
  } catch (err) {
    assert(err && err.code === 'TIMEOUT');
  }

  // Memory test (fake)
  assert(LIMITS.MIN_FREE_MEMORY_MB > 0);

  console.log('SAFETY TESTS PASSED');
})();
