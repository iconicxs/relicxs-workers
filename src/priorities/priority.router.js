/**
 * Resolve queue for a given job based on priority.
 */
const { PRIORITY, getJobPriority } = require('../jobs/job.priority');
const { MACHINIST, ARCHIVIST } = require('./priority.constants');
const { validateJobHasBaseFields } = require('./priority.validation');

/**
 * Decide which queue to send a job to.
 * Validates the job shape before resolving.
 *
 * @param {Record<string, any>} job
 * @returns {string}
 */
function resolveQueueForJob(job) {
  validateJobHasBaseFields(job);
  const priority = getJobPriority(job);
  const type = String(job.job_type || job.type || '').toLowerCase();

  if (type.startsWith('machinist')) {
    if (priority === PRIORITY.INSTANT) return MACHINIST.INSTANT;
    if (priority === PRIORITY.STANDARD) return MACHINIST.STANDARD;
    return MACHINIST.BATCH;
  }

  if (type.startsWith('archivist')) {
    if (priority === PRIORITY.INSTANT) return ARCHIVIST.INSTANT;
    if (priority === PRIORITY.STANDARD) return ARCHIVIST.STANDARD;
    return ARCHIVIST.JOBGROUP;
  }

  throw new Error(`[PRIORITY_ROUTER] Unknown job type: ${type}`);
}

module.exports = { resolveQueueForJob };
