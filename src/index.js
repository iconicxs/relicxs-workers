// Load root module aliases
require('./module-aliases');

/**
 * Main entry: run startup checks and exit.
 */
const { runStartupChecks } = require('./startup/check-env');
const { logger } = require('./core/logger');

(async () => {
  try {
    await runStartupChecks();
    logger.info('Core startup checks passed');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Startup checks failed');
    process.exit(1);
  }
})();
