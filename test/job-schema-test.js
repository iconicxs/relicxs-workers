#!/usr/bin/env node
require('dotenv').config();
require('../src/module-aliases');

const assert = require('assert');
const ValidationError = require('@errors/ValidationError');
const { validateMachinistJob, validateArchivistJob } = require('../src/schema/job-schemas');

const UUID_OK = '00000000-0000-4000-8000-000000000000';

async function expectThrows(name, fn) {
  try {
    await fn();
    console.error(`FAIL: ${name} did not throw`);
    process.exitCode = 1;
  } catch (err) {
    if (err instanceof ValidationError) {
      console.log(`PASS: ${name} threw ValidationError`);
    } else {
      console.error(`FAIL: ${name} threw non-ValidationError`, err);
      process.exitCode = 1;
    }
  }
}

(async () => {
  // 1) invalid UUID (machinist)
  await expectThrows('machinist invalid tenant_id UUID', () =>
    validateMachinistJob({
      tenant_id: 'not-a-uuid',
      asset_id: UUID_OK,
      batch_id: UUID_OK,
      file_purpose: 'viewing',
      input_extension: 'jpg',
    })
  );

  // 2) invalid purpose (machinist)
  await expectThrows('machinist invalid file_purpose', () =>
    validateMachinistJob({
      tenant_id: UUID_OK,
      asset_id: UUID_OK,
      batch_id: UUID_OK,
      file_purpose: 'unknown',
      input_extension: 'jpg',
    })
  );

  // 3) invalid processing_type (archivist)
  await expectThrows('archivist invalid processing_type', () =>
    validateArchivistJob({
      tenant_id: UUID_OK,
      asset_id: UUID_OK,
      batch_id: UUID_OK,
      processing_type: 'individual',
    })
  );

  // 4) missing fields (machinist)
  await expectThrows('machinist missing asset_id', () =>
    validateMachinistJob({
      tenant_id: UUID_OK,
      batch_id: UUID_OK,
      file_purpose: 'viewing',
      input_extension: 'jpg',
    })
  );

  // 5) too long file extension (machinist)
  await expectThrows('machinist too long input_extension', () =>
    validateMachinistJob({
      tenant_id: UUID_OK,
      asset_id: UUID_OK,
      batch_id: UUID_OK,
      file_purpose: 'viewing',
      input_extension: 'a'.repeat(300),
    })
  );

  // 6) non-object job (archivist)
  await expectThrows('archivist non-object', () => validateArchivistJob('not-an-object'));

  if (process.exitCode && process.exitCode !== 0) {
    process.exit(process.exitCode);
  } else {
    console.log('DONE: job-schema-test complete');
  }
})();
