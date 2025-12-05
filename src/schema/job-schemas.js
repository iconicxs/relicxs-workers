const ValidationError = require('@errors/ValidationError');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUUID(name, value) {
  if (!value || typeof value !== 'string' || !UUID_REGEX.test(value)) {
    throw new ValidationError(`INVALID_UUID`, name, `${name} must be a valid UUID v4`);
  }
}

function assertIn(name, value, allowed) {
  if (!allowed.includes(value)) {
    throw new ValidationError(`INVALID_VALUE`, name, `${name} must be one of: ${allowed.join(', ')}`);
  }
}

function assertString(name, value, max = 256) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`INVALID_STRING`, name, `${name} must be a non-empty string`);
  }
  if (value.length > max) {
    throw new ValidationError(`STRING_TOO_LONG`, name, `${name} exceeds ${max} chars`);
  }
}

//
// MACHINIST JOB SCHEMA
//
function validateMachinistJob(job) {
  if (!job || typeof job !== 'object') {
    throw new ValidationError(`INVALID_JOB`, 'job', `Job must be an object`);
  }

  assertUUID('tenant_id', job.tenant_id);
  assertUUID('asset_id', job.asset_id);
  if (job.batch_id != null && job.batch_id !== '') {
    assertUUID('batch_id', job.batch_id);
  }

  assertIn('file_purpose', job.file_purpose, [
    'preservation',
    'viewing',
    'production',
    'restoration'
  ]);

  assertString('input_extension', job.input_extension);

  return job;
}

//
// ARCHIVIST JOB SCHEMA
//
function validateArchivistJob(job) {
  if (!job || typeof job !== 'object') {
    throw new ValidationError(`INVALID_JOB`, 'job', `Job must be an object`);
  }

  assertUUID('tenant_id', job.tenant_id);
  assertUUID('asset_id', job.asset_id);
  if (job.batch_id != null && job.batch_id !== '') {
    assertUUID('batch_id', job.batch_id);
  }

  assertIn('processing_type', job.processing_type, [
    'instant',
    'standard',
    'jobgroup',
    'batch' // legacy alias
  ]);

  return job;
}

module.exports = {
  validateMachinistJob,
  validateArchivistJob,
  assertUUID,
  assertIn,
  assertString
};
