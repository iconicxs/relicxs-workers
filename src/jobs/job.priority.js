/**
 * Job priority mapping and resolver.
 */
const PRIORITY = {
  INSTANT: 'instant',
  STANDARD: 'standard',
  BATCH: 'batch',
};

/**
 * Determine priority for a job.
 * Validates that `job` is an object. Uses `processing_type` to decide:
 * - 'instant' | 'individual' => INSTANT
 * - 'standard'                => STANDARD
 * - 'jobgroup' | 'batch'      => BATCH
 * Any unknown or missing processing_type defaults to STANDARD.
 *
 * @param {Record<string, any>} job
 * @returns {'instant'|'standard'|'batch'}
 */
function getJobPriority(job) {
  if (typeof job !== 'object' || job === null) {
    throw new Error('Invalid job: expected an object');
  }

  const raw = job.processing_type || job.processingType || '';
  const p = String(raw).toLowerCase();
  if (p === 'instant' || p === 'individual') return PRIORITY.INSTANT;
  if (p === 'standard') return PRIORITY.STANDARD;
  if (p === 'jobgroup') return PRIORITY.BATCH;
  return PRIORITY.STANDARD;
}

module.exports = { PRIORITY, getJobPriority };
