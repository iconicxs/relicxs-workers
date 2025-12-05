/**
 * Upload derivatives to storage and record versions in Supabase via RPC.
 */
const { uploadFile } = require('../../core/storage');
const { callRpc } = require('../../core/supabase');

/**
 * Upload a file to B2 and create a Supabase asset version record via RPC.
 * @param {object} params
 * @param {import('pino').Logger} params.logger
 * @param {object} params.job
 * @param {string} params.bucketId
 * @param {string} params.remotePath
 * @param {string} params.localPath
 * @param {string} params.contentType
 * @param {string} params.versionType
 */
async function uploadAndRecord({ logger, job, bucketId, remotePath, localPath, contentType, versionType, purpose, variant }) {
  logger.info({ tenant_id: job.tenant_id, asset_id: job.asset_id, remotePath }, '[MACHINIST][UPLOAD] Uploading file');
  try {
    await uploadFile(bucketId, remotePath, localPath, contentType);
  } catch (err) {
    logger.error({ err, localPath }, '[MACHINIST][UPLOAD] Upload failed');
    // Create failed version record
    try {
      await callRpc({ name: 'create_asset_version', params: { asset_id: job.asset_id, path: remotePath, status: 'failed', version_type: versionType, purpose: purpose || job.file_purpose, variant: variant || versionType }, tenantId: job.tenant_id });
    } catch (rpcErr) {
      logger.error({ err: rpcErr }, '[MACHINIST][UPLOAD] Failed to create failed version record');
    }
    throw err;
  }

  // Create success record
  try {
    await callRpc({ name: 'create_asset_version', params: { asset_id: job.asset_id, path: remotePath, status: 'success', version_type: versionType, purpose: purpose || job.file_purpose, variant: variant || versionType }, tenantId: job.tenant_id });
  } catch (rpcErr) {
    logger.error({ err: rpcErr }, '[MACHINIST][UPLOAD] Failed to create success version record');
    throw rpcErr;
  }
}

async function uploadAndRecordPreservation({ logger, job, bucketId, remotePath, localPath }) {
  return uploadAndRecord({ logger, job, bucketId, remotePath, localPath, contentType: 'application/octet-stream', versionType: 'preservation', purpose: job.file_purpose, variant: 'original' });
}

async function uploadAndRecordViewing({ logger, job, bucketId, remotePath, localPath }) {
  return uploadAndRecord({ logger, job, bucketId, remotePath, localPath, contentType: 'image/jpeg', versionType: 'viewing', purpose: job.file_purpose, variant: 'viewing' });
}

async function uploadAndRecordAI({ logger, job, bucketId, remotePath, localPath }) {
  return uploadAndRecord({ logger, job, bucketId, remotePath, localPath, contentType: 'image/jpeg', versionType: 'ai', purpose: job.file_purpose, variant: 'ai' });
}

async function uploadAndRecordThumbnail({ logger, job, bucketId, remotePath, localPath, size }) {
  return uploadAndRecord({ logger, job, bucketId, remotePath, localPath, contentType: 'image/jpeg', versionType: `thumb_${size}` , purpose: job.file_purpose, variant: `thumb_${size}`});
}

/**
 * Upload metadata JSON and create a version record.
 * @param {object} params
 * @param {import('pino').Logger} params.logger
 * @param {object} params.job
 * @param {string} params.bucketId
 * @param {string} params.remotePath
 * @param {string} params.localPath
 */
async function uploadMetadata({ logger, job, bucketId, remotePath, localPath }) {
  return uploadAndRecord({ logger, job, bucketId, remotePath, localPath, contentType: 'application/json', versionType: 'metadata', purpose: job.file_purpose, variant: 'metadata' });
}

/**
 * Unified upload API for Machinist pipelines.
 * Accepts a buffer + remote path + mime type.
 * Delegates to existing uploadFileToB2() when available or falls back to core/storage.
 */
async function uploadToB2({ buffer, path, mime }) {
  // If an optimized uploader exists, use it
  try {
    if (typeof uploadFileToB2 === 'function') {
      return uploadFileToB2({ fileBuffer: buffer, remotePath: path, contentType: mime });
    }
  } catch (_) {
    // ignore and fall back
  }

  // Fallback: write buffer to tmp file and use core/storage.uploadFile
  const fs = require('fs');
  const os = require('os');
  const p = require('path');
  const config = require('../../core/config');
  const tmpPath = p.join(os.tmpdir(), `machinist-upload-${Date.now()}-${Math.random().toString(36).slice(2)}${p.extname(path) || ''}`);
  fs.writeFileSync(tmpPath, buffer);
  const bucketId = path.includes('/archive/')
    ? (config.b2.processedArchiveBucketId || config.b2.processedStandardBucketId)
    : config.b2.processedStandardBucketId;
  await uploadFile(bucketId, path, tmpPath, mime);
  try { fs.unlinkSync(tmpPath); } catch (_) {}
  return { path, bucketId };
}

module.exports = {
  uploadToB2,
  uploadAndRecordPreservation,
  uploadAndRecordViewing,
  uploadAndRecordAI,
  uploadAndRecordThumbnail,
  uploadMetadata,
};
