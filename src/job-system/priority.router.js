const { validateHandlerForJob, validateBatchOnly } = require('./handler.validation');

/**
 * Select a handler module for a given job priority after validation.
 * Note: This router maps to Archivist handlers per current system design.
 */
function routeHandlerForJob(job) {
  validateBatchOnly(job);
  return validateHandlerForJob(job.priority);
}

module.exports = { routeHandlerForJob };
