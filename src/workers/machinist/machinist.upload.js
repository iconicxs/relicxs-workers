/**
 * Upload derivatives to storage and record versions in Supabase via RPC.
 */
const { uploadFile } = require('../../core/storage');
const { callRpc, supabase } = require('../../core/supabase');
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
  try {
    await uploadFile(bucketId, remotePath, localPath, contentType);
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
    let file_size = null, width = null, height = null, mime_type = contentType || null, bit_depth = null, color_space = null;
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
      .eq('asset_id'