/**
 * Upload derivatives to storage and record versions in Supabase via RPC.
 */
const { uploadFile } = require('../../core/storage');
const { callRpc, supabase } = require('../../core/supabase');
const { detectMime } = require('./machinist.utils');
const path = require('path');
const config = require('../../core/config');

function resolveBucketName(bucketId) {
  try {
    if (!bucketId) return null;
    if (bucketId === config.b2.landingBucketId) return 'B2_landing_bucket';
    if (bucketId === config.b2.processedStandardBucketId) return 'B2_processed_standard_bucket';
    if (bucketId === config.b2.processedArchiveBucketId) return 'B2_processed_archive_bucket';
    if (bucketId === config.b2.filesBucketId) return 'B2_files_bucket';
    if (config.aws && config.aws.archiveBucket && bucketId === config.aws.archiveBucket) return 'AWS_archival';
    return bucketId;
  } catch (_) {
    return bucketId;
  }
}

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
  // Determine effective MIME: treat octet-stream as unspecified and infer
  let effectiveContentType = contentType;
  try {
    if (!effectiveContentType || effectiveContentType === 'application/octet-stream') {
      try {
        const fs = require('fs');
        const buf = fs.readFileSync(localPath);
        const det = detectMime(buf);
        if (det && det.mime) {
          effectiveContentType = det.mime;
        } else {
          const ext = String(path.extname(localPath) || '').toLowerCase();
          if (ext === '.jpg' || ext === '.jpeg') effectiveContentType = 'image/jpeg';
          else if (ext === '.png') effectiveContentType = 'image/png';
          else if (ext === '.tif' || ext === '.tiff') effectiveContentType = 'image/tiff';
        }
      } catch (_) { /* fallback below */ }
    }
  } catch (_) { /* ignore mime inference errors */ }
  try {
    await uploadFile(bucketId, remotePath, localPath, effectiveContentType);
  } catch (err) {
    logger.error({ err, localPath }, '[MACHINIST][UPLOAD] Upload failed');
    // Create failed version record
    try {
      const pv = purpose || job.file_purpose;
      const vr = variant || versionType;
      const { data: existing } = await supabase
        .from('asset_versions')
        .select('id')
        .eq('asset_id', job.asset_id)
        .eq('purpose', pv)
        .eq('variant', vr)
        .eq('type', versionType)
        .limit(1)
        .maybeSingle();
      if (existing && existing.id) {
        await supabase.from('asset_versions').update({
          status: 'failed',
          storage_path: remotePath,
          bucket_name: resolveBucketName(bucketId),
          updated_at: new Date().toISOString(),
        }).eq('id', existing.id);
      } else {
        await callRpc({ name: 'create_asset_version', params: { tenant_id: job.tenant_id, batch_id: job.batch_id || null, asset_id: job.asset_id, path: remotePath, storage_path: remotePath, bucket_name: resolveBucketName(bucketId), status: 'failed', version_type: versionType, purpose: pv, variant: vr }, tenantId: job.tenant_id });
      }
    } catch (rpcErr) {
      logger.error({ err: rpcErr }, '[MACHINIST][UPLOAD] Failed to create failed version record');
    }
    throw err;
  }

  // Create success record
  try {
    // Derive file_size and image dimensions when possible
    let file_size = null, width = null, height = null, mime_type = (effectiveContentType && effectiveContentType !== 'application/octet-stream') ? effectiveContentType : null, bit_depth = null, color_space = null;
    try { const fs = require('fs'); const s = fs.statSync(localPath); file_size = s.size; } catch (_) {}
    try {
      // Attempt to read image metadata (will throw for non-images; safe to ignore)
      const sharp = require('sharp');
      const meta = await sharp(localPath).metadata();
      width = width || meta.width || null;
      height = height || meta.height || null;
      // Map sharp metadata to our schema
      color_space = meta.space || null;
      if (typeof meta.bits === 'number') {
        bit_depth = meta.bits;
      } else if (meta.depth === 'uchar') {
        bit_depth = 8;
      } else if (meta.depth === 'ushort') {
        bit_depth = 16;
      }
      // If mime_type not provided, infer for common formats
      if (!mime_type && meta.format) {
        const fmt = String(meta.format).toLowerCase();
        if (fmt === 'jpeg' || fmt === 'jpg') mime_type = 'image/jpeg';
        else if (fmt === 'png') mime_type = 'image/png';
        else if (fmt === 'tiff' || fmt === 'tif') mime_type = 'image/tiff';
        else if (fmt === 'webp') mime_type = 'image/webp';
        else if (fmt === 'heif' || fmt === 'heic') mime_type = 'image/heic';
        else if (fmt === 'gif') mime_type = 'image/gif';
      }
    } catch (_) {}

    // Fallback to EXIF-derived values when Sharp doesn't provide
    if (!bit_depth && job && job._exifBitDepth) bit_depth = job._exifBitDepth;
    if (!color_space && job && job._exifColorSpace) color_space = job._exifColorSpace;
    if (!mime_type && job && job._exifMimeType) mime_type = job._exifMimeType;

    const pv = purpose || job.file_purpose;
    const vr = variant || versionType;
    const { data: existing } = await supabase
      .from('asset_versions')
      .select('id')
      .eq('asset_id', job.asset_id)
      .eq('purpose', pv)
      .eq('variant', vr)
      .eq('type', versionType)
      .limit(1)
      .maybeSingle();
    if (existing && existing.id) {
      await supabase.from('asset_versions').update({
        name: vr || null,
        file_size,
        width,
        height,
        bit_depth,
        color_space,
        storage_path: remotePath,
        status: 'success',
        checksum: null,
        checksum_algorithm: 'sha256',
        mime_type,
        bucket_name: resolveBucketName(bucketId),
        updated_at: new Date().toISOString(),
      }).eq('id', existing.id);
    } else {
      await callRpc({
        name: 'create_asset_version',
        params: {
          tenant_id: job.tenant_id,
          batch_id: job.batch_id || null,
          asset_id: job.asset_id,
          name: vr || null,
          type: versionType,
          purpose: pv,
          variant: vr,
          file_size,
          width,
          height,
          bit_depth,
          color_space,
          metadata: null,
          storage_path: remotePath,
          status: 'success',
          checksum: null,
          checksum_algorithm: 'sha256',
          mime_type,
          bucket_name: resolveBucketName(bucketId),
          path: remotePath,
        },
        tenantId: job.tenant_id,
      });
    }
  } catch (rpcErr) {
    logger.error({ err: rpcErr }, '[MACHINIST][UPLOAD] Failed to create success version record');
    throw rpcErr;
  }
}

async function uploadAndRecordPreservation({ logger, job, bucketId, remotePath, localPath }) {
  return uploadAndRecord({ logger, job, bucketId, remotePath, localPath, contentType: 'application/octet-stream', versionType: 'preservation', purpose: job.file_purpose, variant: 'original' });
}

async function uploadAndRecordViewing({ logger, job, bucketId, remotePath, localPath }) {
  return uploadAndRecord({ logger, job, bucketId, remotePath, localPath, contentType: 'image/jpeg', versionType: 'viewing', purpose: 'viewing', variant: 'processed' });
}

async function uploadAndRecordAI({ logger, job, bucketId, remotePath, localPath }) {
  return uploadAndRecord({ logger, job, bucketId, remotePath, localPath, contentType: 'image/jpeg', versionType: 'ai', purpose: 'ai', variant: 'ai' });
}

async function uploadAndRecordThumbnail({ logger, job, bucketId, remotePath, localPath, size }) {
  // Purpose and type as 'thumbnail', variant as size label (small|medium|large)
  return uploadAndRecord({ logger, job, bucketId, remotePath, localPath, contentType: 'image/jpeg', versionType: 'thumbnail', purpose: 'thumbnail', variant: size });
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
  uploadAndRecord,
  uploadToB2,
  uploadAndRecordPreservation,
  uploadAndRecordViewing,
  uploadAndRecordAI,
  uploadAndRecordThumbnail,
  uploadMetadata,
};
