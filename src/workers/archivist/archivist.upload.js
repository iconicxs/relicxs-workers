/**
 * ARCHIVIST UPLOAD MODULE
 * ------------------------
 * Archivist outputs *JSON results* (AI descriptions, tags, face matches, etc.)
 * These need to be stored in B2/Glacier for durability + audit trail.
 *
 * This module handles ONLY JSON-result uploads.
 * (Image derivatives are handled by machinist.upload.js)
 */

const { uploadFile } = require('../../core/storage');
const { sendToDLQ } = require('../../resilience/dlq');

/**
 * Upload AI JSON result (analysis output) to B2.
 *
 * @param {import("pino").Logger} logger
 * @param {object} params
 * @param {object} params.job
 * @param {string} params.bucketId
 * @param {string} params.remotePath
 * @param {string} params.localPath
 */
async function uploadAiJsonResult({ logger, job, bucketId, remotePath, localPath }) {
  try {
    await uploadFile(bucketId, remotePath, localPath, "application/json");

    logger.info({ remotePath }, "[ARCHIVIST UPLOAD] AI JSON uploaded");

    return { ok: true, remotePath };
  } catch (err) {
    logger.error({ err, remotePath }, "[ARCHIVIST UPLOAD] AI JSON upload failed");

    // Archivist MUST push failures to DLQ
    await sendToDLQ(job, "ai_json_upload_failed:" + err.message, logger);

    throw err;
  }
}

module.exports = {
  uploadAiJsonResult,
};
