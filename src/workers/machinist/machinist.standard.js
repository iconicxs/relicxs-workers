/**
 * MACHINIST STANDARD PROCESSOR
 * --------------------------------
 * Generates all non-preservation derivatives:
 *   - viewing
 *   - thumbnails
 *   - ai
 * Enforces consistency rules and uploads versions.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const fse = require('fs-extra');
const {
  validateMachinistJob,
  validateImageBuffer,
  detectMime,
} = require('./machinist.utils');
const { normalizeFilename, enforceResolution, normalizeExif } = require('./machinist.consistency');
const { extractExifMetadata } = require('./machinist.exif');
const sharp = require('sharp');

const { generateDerivatives } = require('./machinist.sharp');
const { mergeMetadata } = require('./machinist.metadata');
const { uploadMetadata } = require('./machinist.upload');

const {
  uploadAndRecordViewing,
  uploadAndRecordThumbnail,
  uploadAndRecordAI,
} = require('./machinist.upload');
const { downloadFile } = require('../../core/storage');

const { sendToDLQ } = require('../../resilience/dlq');
const wrap = require('../../errors/wrap');
const { withRetry } = require('../../resilience/retry');
const config = require('../../core/config');
const { recordJobStart, recordJobEnd } = require('../../metrics/runtime');
const { logStart, logEnd, logFailure } = require('../../resilience/logging');
const { sanitizeExt } = require('@security/sanitize');
const { updateBatchStatus } = require('../../resilience/batch-status');

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (_) { fse.ensureDirSync(p); }
}

/**
 * Process standard derivatives with robust validation + DLQ.
 * @param {import('pino').Logger} logger
 * @param {{ tenant_id: string, asset_id: string, file_purpose?: string, input_buffer?: Buffer }} job
 */
async function processStandardMachinistJob(logger, job) {
  try {
    try { await recordJobStart(job); } catch (_) {}
    logStart(logger, job);
    validateMachinistJob(job);

    const tenantId = job.tenant_id;
    const assetId = job.asset_id;
    const workDir = path.join(os.tmpdir(), `machinist-standard-${tenantId}-${assetId}-${Date.now()}`);
    ensureDir(workDir);

    // 1) Download original from storage and validate
    const batchId = job.batch_id || 'unknown';
    if (job.input_extension && !sanitizeExt(job.input_extension)) {
      throw new Error('[MACHINIST][STANDARD] Unsafe or unsupported input_extension');
    }
    let ext = sanitizeExt((job.original_extension || job.extension || job.input_extension || ''));
    // If extension not provided, attempt to fetch from Supabase asset.storage_path
    let assetStoragePath = null;
    if (!ext) {
      try {
        const { supabase } = require('../../core/supabase');
        const { data: assetRow } = await supabase
          .from('asset')
          .select('storage_path')
          .eq('id', job.asset_id)
          .single();
        const p = assetRow && assetRow.storage_path ? String(assetRow.storage_path) : '';
        if (p) assetStoragePath = p;
        const m = p.match(/\.([A-Za-z0-9]+)$/);
        if (m && m[1]) {
          const guessed = sanitizeExt(m[1]);
          if (guessed) ext = guessed;
        }
      } catch (_) {}
    }
    // Candidate extensions to try when not provided
    const extCandidates = [];
    if (ext) extCandidates.push(ext);
    for (const e of ['tif', 'tiff', 'jpg', 'jpeg', 'png']) {
      if (!extCandidates.includes(e)) extCandidates.push(e);
    }
    let inputLocalPath = null;
    let downloaded = false;
    // Prefer using storage_path when available (authoritative)
    if (assetStoragePath) {
      try {
        const sp = String(assetStoragePath);
        const extMatch = sp.match(/\.([A-Za-z0-9]+)$/);
        const e = extMatch && extMatch[1] ? sanitizeExt(extMatch[1]) : (ext || 'jpg');
        const localPath = path.join(workDir, `original.${e || 'jpg'}`);
        await wrap(
          () => withRetry(
            () => downloadFile(config.b2.landingBucketId || config.b2.processedStandardBucketId, sp, localPath),
            { logger, maxRetries: 2, baseDelay: 500, context: { step: 'download-original' } }
          ),
          logger,
          { step: 'download-original' }
        );
        ext = e;
        inputLocalPath = localPath;
        downloaded = true;
      } catch (_) {
        // fall through to constructed paths
      }
    }
    // Fallback: try common constructed paths by extension
    if (!downloaded) {
      for (const e of extCandidates) {
        const landingPath = path.posix.join(`tenant-${tenantId}`, `batch-${batchId}`, `asset-${assetId}`, `original.${e}`);
        const localPath = path.join(workDir, `original.${e}`);
        try {
          await wrap(
            () => withRetry(
              () => downloadFile(config.b2.landingBucketId || config.b2.processedStandardBucketId, landingPath, localPath),
              { logger, maxRetries: 2, baseDelay: 500, context: { step: 'download-original' } }
            ),
            logger,
            { step: 'download-original' }
          );
          ext = e;
          inputLocalPath = localPath;
          downloaded = true;
          break;
        } catch (e1) {
          continue;
        }
      }
    }
    if (!downloaded) {
      throw new Error('[MACHINIST][STANDARD] Failed to download original with any known extension');
    }

    const fileBuf = fs.readFileSync(inputLocalPath);
    await validateImageBuffer(fileBuf);
    const det = detectMime(fileBuf);
    if (!det || !det.mime) throw new Error('UNSUPPORTED_MIME');
    const meta = await sharp(fileBuf).metadata();
    enforceResolution(meta.width, meta.height);

    // Extract EXIF (normalized)
    let exifNormalized = {};
    try {
      const rawExif = await extractExifMetadata(inputLocalPath);
      exifNormalized = normalizeExif(rawExif);
      // Attach for downstream fallbacks
      try { job._exifBitDepth = job._exifBitDepth || null; } catch (_) {}
    } catch (e) {
      logger.warn({ err: e }, '[MACHINIST][STANDARD] EXIF extraction failed');
    }

    // 2a) Upload ORIGINAL into processed storage FIRST (fatal if this fails)
    //     This guarantees the source is preserved before any derivative work.
    {
      const purpose = (job.file_purpose || 'viewing').toLowerCase();
      const uploadAndRecord = require('./machinist.upload').uploadAndRecord;
      if (!uploadAndRecord) throw new Error('uploadAndRecord missing');
      const fileName = `original.${ext}`;
      const { fileExists } = require('../../core/storage');
      let origRemote = null;
      if (purpose === 'preservation') {
        origRemote = path.posix.join(`tenant-${tenantId}`, `batch-${batchId}`,
          `asset-${assetId}`,
          'preservation',
          fileName
        );
        const bucketId = config.b2.processedArchiveBucketId || config.b2.processedStandardBucketId;
        // Idempotency: skip if exists
        const exists = await fileExists(bucketId, origRemote).catch(() => false);
        if (!exists) {
          await wrap(
            () => withRetry(
              () => uploadAndRecord({
                logger,
                job,
                bucketId,
                remotePath: origRemote,
                localPath: inputLocalPath,
                contentType: 'application/octet-stream',
                versionType: 'preservation',
                purpose: 'preservation',
                variant: 'original',
              }),
              { logger, maxRetries: 2, baseDelay: 500, context: { step: 'upload-original-preservation' } }
            ),
            logger,
            { step: 'upload-original-preservation' }
          );
        } else {
          logger.info({ origRemote }, '[MACHINIST][STANDARD] Original already exists (preservation); skipping upload');
        }
      } else if (purpose === 'viewing' || purpose === 'production' || purpose === 'restoration') {
        origRemote = path.posix.join(`tenant-${tenantId}`, `batch-${batchId}`,
          `asset-${assetId}`,
          purpose,
          fileName
        );
        const bucketId = config.b2.processedStandardBucketId;
        const exists = await fileExists(bucketId, origRemote).catch(() => false);
        if (!exists) {
          await wrap(
            () => withRetry(
              () => uploadAndRecord({
                logger,
                job,
                bucketId,
                remotePath: origRemote,
                localPath: inputLocalPath,
                contentType: 'application/octet-stream',
                versionType: purpose,
                purpose,
                variant: 'original',
              }),
              { logger, maxRetries: 2, baseDelay: 500, context: { step: 'upload-original' } }
            ),
            logger,
            { step: 'upload-original' }
          );
        } else {
          logger.info({ origRemote }, '[MACHINIST][STANDARD] Original already exists; skipping upload');
        }
      }
    }

    // 2) Generate derivatives
    const derivatives = await wrap(
      () => withRetry(
        () => generateDerivatives({ logger, job, inputPath: inputLocalPath, workDir }),
        { logger, maxRetries: 2, baseDelay: 500, context: { step: 'sharp-derivatives' } }
      ),
      logger,
      { step: 'sharp-derivatives' }
    );

    // 3) Upload viewing
    if (derivatives.viewing) {
      const viewingRemote = path.posix.join(`tenant-${tenantId}`, `batch-${batchId}`,
        `asset-${assetId}`,
        'viewing',
        `${normalizeFilename('viewing')}.jpg`
      );
      try {
        // purpose=viewing, variant=processed
        await wrap(
          () => withRetry(
            () => require('./machinist.upload').uploadAndRecord({ logger, job, bucketId: config.b2.processedStandardBucketId, remotePath: viewingRemote, localPath: derivatives.viewing.localPath, contentType: 'image/jpeg', versionType: 'viewing', purpose: 'viewing', variant: 'processed' }),
            { logger, maxRetries: 2, baseDelay: 500, context: { step: 'upload-viewing' } }
          ),
          logger,
          { step: 'upload-viewing' }
        );
      } catch (e) {
        logger.error({ err: e }, '[MACHINIST] Viewing upload failed (continuing)');
        try { await sendToDLQ(job, 'derivative_upload_failed:' + (e?.message || String(e)), logger); } catch (_) {}
      }
    }

    // 4) Upload AI
    if (derivatives.ai) {
      const aiRemote = path.posix.join(`tenant-${tenantId}`, `batch-${batchId}`,
        `asset-${assetId}`,
        'ai',
        `${normalizeFilename('ai')}.jpg`
      );
      try {
        await wrap(
          () => withRetry(
            () => uploadAndRecordAI({ logger, job, bucketId: config.b2.processedStandardBucketId, remotePath: aiRemote, localPath: derivatives.ai.localPath }),
            { logger, maxRetries: 2, baseDelay: 500, context: { step: 'upload-ai' } }
          ),
          logger,
          { step: 'upload-ai' }
        );
      } catch (e) {
        logger.error({ err: e }, '[MACHINIST] AI upload failed (continuing)');
        try { await sendToDLQ(job, 'derivative_upload_failed:' + (e?.message || String(e)), logger); } catch (_) {}
      }
    }

    // 5) Upload thumbnails
    if (Array.isArray(derivatives.thumbnails)) {
      for (const tn of derivatives.thumbnails) {
        const tnRemote = path.posix.join(`tenant-${tenantId}`, `batch-${batchId}`,
          `asset-${assetId}`,
          'thumbnails',
          `${normalizeFilename(`thumb-${tn.size}`)}.jpg`
        );
        try {
          await wrap(
            () => withRetry(
              () => uploadAndRecordThumbnail({ logger, job, bucketId: config.b2.processedStandardBucketId, remotePath: tnRemote, localPath: tn.localPath, size: tn.size }),
              { logger, maxRetries: 2, baseDelay: 500, context: { step: 'upload-thumb', size: tn.size } }
            ),
            logger,
            { step: 'upload-thumb' }
          );
        } catch (e) {
          logger.error({ err: e, size: tn.size }, '[MACHINIST] Thumbnail upload failed (continuing)');
          try { await sendToDLQ(job, 'derivative_upload_failed:' + (e?.message || String(e)), logger); } catch (_) {}
        }
      }
    }

    // Attach merged metadata to ORIGINAL record and upload manifest.json to files bucket
    try {
      const aiBlock = job.ai_metadata || null;
      const merged = await mergeMetadata({ exif: exifNormalized, ai: aiBlock, job });
      const manifestLocal = path.join(workDir, 'manifest.json');
      await fse.writeJson(manifestLocal, merged, { spaces: 2 });

      // Compute checksum
      const fs = require('fs');
      const crypto = require('crypto');
      const buf = fs.readFileSync(manifestLocal);
      const checksum = crypto.createHash('sha256').update(buf).digest('hex');

      // Prefer files bucket
      const filesBucket = config.b2.filesBucketId || config.b2.processedStandardBucketId;
      const manifestRemote = path.posix.join(`tenant-${tenantId}`, `batch-${batchId}`,
        `asset-${assetId}`,
        'metadata',
        'manifest.json'
      );
      await require('../../core/storage').uploadFile(filesBucket, manifestRemote, manifestLocal, 'application/json');

      // Upsert attachment into ORIGINAL version row
      const { supabase } = require('../../core/supabase');
      const pv = (job.file_purpose || 'viewing').toLowerCase();
      const { data: existing } = await supabase
        .from('asset_versions')
        .select('id')
        .eq('asset_id', job.asset_id)
        .eq('purpose', pv)
        .eq('variant', 'original')
        .limit(1)
        .maybeSingle();
      if (existing && existing.id) {
        await supabase.from('asset_versions').update({
          metadata: merged,
          metadata_storage_path: manifestRemote,
          metadata_checksum: checksum,
          metadata_bucket_name: 'B2_files_bucket',
          updated_at: new Date().toISOString(),
        }).eq('id', existing.id);
      } else {
        logger.warn('[MACHINIST][STANDARD] original version not found for metadata attach');
      }
    } catch (err) {
      logger.warn({ err }, '[MACHINIST][STANDARD] failed to attach/upload metadata');
    }

    const result = { status: 'complete' };
    logEnd(logger, job, result);
    try { await updateBatchStatus(job.batch_id); } catch (e) { logger.warn({ e }, '[MACHINIST][STANDARD] updateBatchStatus failed'); }
    return result;
  } catch (err) {
    logFailure(logger, job, err);
    logger.error({ err, tenant_id: job?.tenant_id, asset_id: job?.asset_id }, '[MACHINIST][STANDARD] Failed');
    try { await sendToDLQ(job, err.message || String(err), logger); } catch (_) {}
    try { await updateBatchStatus(job.batch_id); } catch (e) { logger.warn({ e }, '[MACHINIST][STANDARD] updateBatchStatus failed'); }
    throw err;
  }
  finally {
    try { await recordJobEnd(job); } catch (_) {}
  }
}

module.exports = { processStandardMachinistJob };
