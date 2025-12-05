/**
 * Initialize worker environment: run checks and provide scoped logger.
 */
const { runStartupChecks } = require('./check-env');
const { createChildLogger } = require('../core/logger');

/**
 * @param {{ componentName: string }} params
 */
async function initializeWorkerEnvironment({ componentName }) {
  await runStartupChecks();
  const logger = createChildLogger({ component: componentName });
  return { logger };
}

module.exports = { initializeWorkerEnvironment };
