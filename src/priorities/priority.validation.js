/**
 * Lightweight validation helpers for job payloads.
 */

/**
 * Validate that a job contains required base fields.
 * Ensures `tenant_id` exists and either `job_type` or `processing_type` exists.
 * Throws a descriptive Error when validation fails.
 *
 * @param {Record<string, any>} job
 */
function validateJobHasBaseFields(job) {
  if (typeof job !== 'object' || job === null) {
    throw new Error('Invalid job: expected an object');
  }
  if (!job.tenant_id && !job.tenantId) {
    throw new Error('Invalid job: missing tenant_id');
  }
  if (!job.job_type && !job.jobType && !job.processing_type && !job.processingType) {
    throw new Error('Invalid job: missing job_type or processing_type');
  }
}

module.exports = { validateJobHasBaseFields };
