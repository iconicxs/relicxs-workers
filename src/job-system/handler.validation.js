const handlers = {
  instant: require('../workers/archivist/archivist.instant'),
  standard: require('../workers/archivist/archivist.standard'),
  batch: require('../workers/archivist/archivist.batch'),
};

/**
 * Ensure a handler exists for the given priority.
 */
function validateHandlerForJob(priority) {
  if (!handlers[priority]) {
    throw new Error(`NO_HANDLER: Missing handler for priority ${priority}`);
  }
  return handlers[priority];
}

/**
 * Prevent non-batch jobs from calling archivist.batch.
 */
function validateBatchOnly(job) {
  if (job.priority === 'batch') return;

  if (job.type === 'archivist.batch') {
    throw new Error(
      `INVALID_HANDLER_USE: archivist.batch used for non-batch priority`
    );
  }
}

module.exports = {
  validateHandlerForJob,
  validateBatchOnly,
};
