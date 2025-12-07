/**
 * Central orchestrator for machinist pipeline.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const fse = require('fs-extra');
const pLimit = require('p-limit');
const { extractExifMetadata } = require('./machinist.exif');
const { generateDerivatives } = require('./machinist.sharp');
const { uploadAndRecordPreservation, uploadAndRecordViewing, uploadAndRecordAI, uploadAndRecordThumbnail, uploadMetadata } = require('./machinist.upload');
const { archiveAssetToGlacier } = require('./machinist.archive');
const { downloadFile } = require('../../core/storage');
const config = require('../../core/config');
const wrap = require('../../errors/wrap');
const { withRetry } = require('../../resilience/retry');
const { sanitizeExt } = require('@security/sanitize');
const { validateMachinistJob, validateImageBuffer, detectMime, correctExtension } = require('./machinist.utils');
const { normalizeExif, enforceResolution, normalizeFilename } = require('./machinist.consistency');
const sharp = require('sharp');
const { mergeMetadata } = require('./machinist.metadata');
const { sendToDLQ } = require('../../resilience/dlq');
const { logFailure } = require('../../resilience/logging');
const ValidationError = require('../../errors/ValidationError');

const sharpLimit = pLimit(3);

/**
 * Create a temporary work directory for a job
 * @param {string} tenantId
 * @param {string} assetId
 */
function createWorkDir(tenantId, assetId) {
  const dir = path.join(os.tmpdir(), `relicxs-${tenantId}-${assetId}-${Date.now()}`);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (_) { fse.ensureDirSync(dir); }
  return dir;
}

/**
 * Run the full machinist pipeline for a single job (FINAL SPEC).
 * @param {import('pino').Logger} logger
 * @param {object} job
 */
async function runMachinistPipeline(logger, job) {
  const LIMITS = require('@safety/runtime-limits');
  try {
    validateMachinistJob(job);
  } catch (err) {
    logFailure(logger, job, err);
    try { await sendToDLQ(job, err.message || String(err), logger); } catch (_) {}
    throw err;
  }
  if (os.freemem() / (1024 * 1024) < LIMITS.MIN_FREE_MEMORY_MB) {
    throw new Error('Insufficient free memory to safely process asset');
  }
  const workDir = createWorkDir(job.tenant_id, job.asset_id);
  const versions = {};
  let inputLocalPath = null;

  if (config.dryRun) {
    logger.warn(`[DRY_RUN] Skipping machinist pipeline for asset ${job.asset_id}`);
    try { await fs.rm(workDir, { recursive: true, force: true }); } catch (_) {}
    return {
      status: 'dry-run',
      ok: true,
      dryRun: true,
      viewingUrl: 'dry-run-viewing.jpg',
      aiUrl: 'dry-run-ai.jpg',
    };
  }

  try {
    // 1) Build LANDING input path and download original
    const tenantId = job.tenant_id;
    const batchId = job.batch_id || 'unknown';
    const assetId = job.asset_id;
    // Enforce whitelist if provided explicitly on job
    if (job.input_extension && !sanitizeExt(job.input_extension)) {
      throw new Error('[MACHINIST][PIPELINE] Unsafe or unsupported input_extension');
    }
    let ext = sanitizeExt((job.original_extension || job.extension || job.input_extension || 'jpg'));
    if (!ext) throw new Error('[MACHINIST][PIPELINE] Unsafe or unsupported extension');
    // Download from landing bucket root (no extra 'landing/' prefix)
    const landingPath = path.posix.join(`tenant-${tenantId}`, `batch-${batchId}`, `asset-${assetId}`, `original.${ext}`);
    inputLocalPath = path.join(workDir, `original.${ext}`);
    await wrap(() => withRetry(() => downloadFile(config.b2.landingBucketId || config.b2.processedStandardBucketId, landingPath, inputLocalPath), { logger, maxRetries: 2, baseDelay: 500, context: { step: 'download-original' } }), logger, { step: 'download-original' });

    // Phase 2: buffer validation and mime detection
    const fileBuf = fs.readFileSync(inputLocalPath);
    await validateImageBuffer(fileBuf);
    const det = detectMime(fileBuf);
    if (det && det.extension && ext !== det.extension) {
      // Correct remote original naming extension, keep local file as-is
      logger.warn({ expected: ext, detected: det.extension }, '[MACHINIST] Correcting original extension for remote path');
      ext = det.extension;
    }
    // Enforce resolution limits via sharp metadata
    const sharpMeta = await sharp(fileBuf).metadata();
    enforceResolution(sharpMeta.width, sharpMeta.height);

    // 2. Extract EXIF metadata (normalized)
    let exif = {};
    let _exifBitDepth = null;
    let _exifColorSpace = null;
    let _exifMimeType = null;
    try {
      const rawExif = await extractExifMetadata(inputLocalPath);
      // Derive color space and bit depth from raw EXIF when available
      try {
        const bits = rawExif?.BitsPerSample || rawExif?.BitDepth || rawExif?.BitsPerPixel || null;
        if (typeof bits === 'string') {
          // e.g., "8 8 8" -> 8
          const first = parseInt(bits.split(/\s+/)[0], 10);
          if (!isNaN(first)) _exifBitDepth = first;
        } else if (typeof bits === 'number') {
          _exifBitDepth = bits;
        } else if (Array.isArray(bits) && bits.length > 0) {
          const first = parseInt(bits[0], 10);
          if (!isNaN(first)) _exifBitDepth = first;
        }
        const cs = rawExif?.ColorSpace || rawExif?.PhotometricInterpretation || rawExif?.ProfileDescription || null;
        if (cs && typeof cs === 'string') _exifColorSpace = cs;
        const mt = rawExif?.MIMEType || rawExif?.MimeType || null;
        if (mt && typeof mt === 'string') _exifMimeType = mt;
      } catch (_) {}
      exif = normalizeExif(rawExif);
    } catch (err) {
      logger.warn({ err }, '[MACHINIST] EXIF extraction failed, continuing with empty EXIF');
    }
    // Attach EXIF-derived fallbacks for downstream upload recording
    try { job._exifBitDepth = _exifBitDepth; job._exifColorSpace = _exifColorSpace; job._exifMimeType = _exifMimeType; } catch (_) {}
    const metaPathLocal = path.join(workDir, 'metadata.json');
    await fse.writeJson(metaPathLocal, exif, { spaces: 2 });
    const metaRemote = path.posix.join('standard', `tenant-${tenantId}`, `asset-${assetId}`, 'metadata', 'metadata.json');
    await wrap(() => withRetry(() => uploadMetadata({ logger, job, bucketId: config.b2.processedStandardBucketId, remotePath: metaRemote, localPath: metaPathLocal }), { logger, maxRetries: 2, baseDelay: 500, context: { step: 'upload-metadata' } }), logger, { step: 'upload-metadata' });

    // Phase 2: merged manifest.json (EXIF + AI)
    try {
      const aiMetadata = job.ai_metadata || null; // Future-proof: AI pipeline injects this.
      const merged = await mergeMetadata({ exif, ai: aiMetadata, job });

      const manifestLocal = path.join(workDir, 'manifest.json');
      await fse.writeJson(manifestLocal, merged, { spaces: 2 });

      const manifestRemote = path.posix.join(
        'standard',
        `tenant-${tenantId}`,
        `asset-${assetId}`,
        'metadata',
        'manifest.json'
      );

      await wrap(
        () => withRetry(
          () => uploadMetadata({
            logger,
            job,
            bucketId: config.b2.processedStandardBucketId,
            remotePath: manifestRemote,
            localPath: manifestLocal
          }),
          { logger, maxRetries: 2, baseDelay: 500, context: { step: 'upload-merged-manifest' } }
        ),
        logger,
        { step: 'upload-merged-manifest' }
      );
    } catch (mErr) {
      logger.warn({ err: mErr }, '[MACHINIST] Failed to create/upload merged manifest');
    }

    // 3. Upload original based on purpose
    const purpose = (job.file_purpose || 'viewing').toLowerCase();
    if (purpose === 'preservation') {
      // File-size guard before any processing
      try {
        const stats = fs.statSync(inputLocalPath);
        if (stats.size > LIMITS.MAX_INPUT_BYTES) {
          throw new ValidationError('FILE_TOO_LARGE', 'input', `Input file exceeds ${Math.round(LIMITS.MAX_INPUT_BYTES / (1024 * 1024))}MB limit`);
        }
      } catch (e) {
        if (e.code === 'ENOENT') {
          throw new ValidationError('INPUT_NOT_FOUND', 'input', 'Downloaded input file not found');
        }
        throw e;
      }
      const origRemote = path.posix.join('standard', `tenant-${tenantId}`, `asset-${assetId}`, 'preservation', `${normalizeFilename('original')}.${ext}`);
      const { fileExists } = require('../../core/storage');
      const bucketId = config.b2.processedArchiveBucketId || config.b2.processedStandardBucketId;
      const exists = await fileExists(bucketId, origRemote).catch(() => false);
      if (!exists) {
        await wrap(() => withRetry(() => uploadAndRecordPreservation({ logger, job, bucketId, remotePath: origRemote, localPath: inputLocalPath }), { logger, maxRetries: 2, baseDelay: 500, context: { step: 'upload-preservation' } }), logger, { step: 'upload-preservation' });
      } else {
        logger.info({ origRemote }, '[MACHINIST][PIPELINE] Preservation original exists; skipping upload');
      }
      versions.preservation = { path: origRemote };
    } else if (purpose === 'viewing') {
      const origViewRemote = path.posix.join('standard', `tenant-${tenantId}`, `asset-${assetId}`, 'viewing', `${normalizeFilename('original')}.${ext}`);
      const { fileExists } = require('../../core/storage');
      const exists = await fileExists(config.b2.processedStandardBucketId, origViewRemote).catch(() => false);
      if (!exists) {
        // For original under viewing, we want purpose=viewing, variant=original
        await wrap(() => withRetry(() => uploadAndRecord({ logger, job, bucketId: config.b2.processedStandardBucketId, remotePath: origViewRemote, localPath: inputLocalPath, contentType: 'application/octet-stream', versionType: 'viewing', purpose: 'viewing', variant: 'original' }), { logger, maxRetries: 2, baseDelay: 500, context: { step: 'upload-viewing-original' } }), logger, { step: 'upload-viewing-original' });
      } else {
        logger.info({ origViewRemote }, '[MACHINIST][PIPELINE] Viewing original exists; skipping upload');
      }
      versions.viewing_original = { path: origViewRemote };
    } else if (purpose === 'production') {
      const origProdRemote = path.posix.join('standard', `tenant-${tenantId}`, `asset-${assetId}`, 'production', `${normalizeFilename('original')}.${ext}`);
      const { fileExists } = require('../../core/storage');
      const prodExists = await fileExists(config.b2.processedStandardBucketId, origProdRemote).catch(() => false);
      if (!prodExists) {
        await wrap(() => withRetry(() => uploadAndRecord({ logger, job, bucketId: config.b2.processedStandardBucketId, remotePath: origProdRemote, localPath: inputLocalPath, contentType: 'application/octet-stream', versionType: 'production', purpose: 'production', variant: 'original' }), { logger, maxRetries: 2, baseDelay: 500, context: { step: 'upload-production-original' } }), logger, { step: 'upload-production-original' });
      } else {
        logger.info({ origProdRemote }, '[MACHINIST][PIPELINE] Production original exists; skipping upload');
      }
      versions.production_original = { path: origProdRemote };
    } else if (purpose === 'restoration') {
      const origRestRemote = path.posix.join('standard', `tenant-${tenantId}`, `asset-${assetId}`, 'restoration', `${normalizeFilename('original')}.${ext}`);
      const { fileExists } = require('../../core/storage');
      const restExists = await fileExists(config.b2.processedStandardBucketId, origRestRemote).catch(() => false);
      if (!restExists) {
        await wrap(() => withRetry(() => uploadAndRecord({ logger, job, bucketId: config.b2.processedStandardBucketId, remotePath: origRestRemote, localPath: inputLocalPath, contentType: 'application/octet-stream', versionType: 'restoration', purpose: 'restoration', variant: 'original' }), { logger, maxRetries: 2, baseDelay: 500, context: { step: 'upload-restoration-original' } }), logger, { step: 'upload-restoration-original' });
      } else {
        logger.info({ origRestRemote }, '[MACHINIST][PIPELINE] Restoration original exists; skipping upload');
      }
      versions.restoration_original = { path: origRestRemote };
      } else {
        throw new ValidationError('INVALID_PURPOSE', 'file_purpose', `Unsupported purpose: ${job.file_purpose}`);
    }

    // 4. Generate derivatives via Sharp
    const filePurpose = (job.file_purpose || 'viewing').toLowerCase();
    const derivatives = await wrap(() => withRetry(() => generateDerivatives({ logger, job, inputPath: inputLocalPath, workDir, sharpLimit }), { logger, maxRetries: 2, baseDelay: 500, context: { step: 'sharp-derivatives' } }), logger, { step: 'sharp-derivatives' });

    // 5. Upload derivatives and record versions
    if (derivatives.viewing) {
      const viewingRemote = path.posix.join(
        'standard',
        `tenant-${tenantId}`,
        `asset-${assetId}`,
        'viewing',
        `${normalizeFilename('viewing')}.jpg`
      );
      try {
        // derivative viewing: purpose=viewing, variant=processed
        await wrap(() => withRetry(() => uploadAndRecord({ logger, job, bucketId: config.b2.processedStandardBucketId, remotePath: viewingRemote, localPath: derivatives.viewing.localPath, contentType: 'image/jpeg', versionType: 'viewing', purpose: 'viewing', variant: 'processed' }), { logger, maxRetries: 2, baseDelay: 500, context: { step: 'upload-viewing' } }), logger, { step: 'upload-viewing' });
        versions.viewing = { path: viewingRemote };
      } catch (e) {
        logger.error({ err: e }, '[MACHINIST] Viewing derivative failed (continuing)');
        try { await sendToDLQ(job, 'derivative_upload_failed:' + (e && e.message ? e.message : String(e)), logger); } catch (_) {}
      }
    }

    if (derivatives.ai) {
      const aiRemote = path.posix.join(
        'standard',
        `tenant-${tenantId}`,
        `asset-${assetId}`,
        'ai',
        `${normalizeFilename('ai')}.jpg`
      );
      try {
        await wrap(() => withRetry(() => uploadAndRecordAI({ logger, job, bucketId: config.b2.processedStandardBucketId, remotePath: aiRemote, localPath: derivatives.ai.localPath }), { logger, maxRetries: 2, baseDelay: 500, context: { step: 'upload-ai' } }), logger, { step: 'upload-ai' });
        versions.ai = { path: aiRemote };
      } catch (e) {
        logger.error({ err: e }, '[MACHINIST] AI derivative failed (continuing)');
        try { await sendToDLQ(job, 'derivative_upload_failed:' + (e && e.message ? e.message : String(e)), logger); } catch (_) {}
      }
    }

    if (Array.isArray(derivatives.thumbnails)) {
      versions.thumbnails = [];
      for (const tn of derivatives.thumbnails) {
        const tnRemote = path.posix.join(
          'standard',
          `tenant-${tenantId}`,
          `asset-${assetId}`,
          'thumbnails',
          `${normalizeFilename(`thumb-${tn.size}`)}.jpg`
        );
        try {
          await wrap(() => withRetry(() => uploadAndRecordThumbnail({ logger, job, bucketId: config.b2.processedStandardBucketId, remotePath: tnRemote, localPath: tn.localPath, size: tn.size }), { logger, maxRetries: 2, baseDelay: 500, context: { step: 'upload-thumb', size: tn.size } }), logger, { step: 'upload-thumb' });
          versions.thumbnails.push({ path: tnRemote, size: tn.size });
        } catch (e) {
          logger.error({ err: e, size: tn.size }, '[MACHINIST] Thumbnail derivative failed (continuing)');
          try { await sendToDLQ(job, 'derivative_upload_failed:' + (e && e.message ? e.message : String(e)), logger); } catch (_) {}
        }
      }
    }

    // 6. Archive batch to Glacier (optional)
    if (filePurpose === 'preservation') {
      try {
        await wrap(() => withRetry(() => archiveAssetToGlacier(logger, job, workDir), { logger, maxRetries: 2, baseDelay: 500, context: { step: 'glacier-archive' } }), logger, { step: 'glacier-archive' });
      } catch (err) {
        logger.warn({ err }, '[MACHINIST][PIPELINE] Archive to Glacier failed; continuing');
      }
    }

    // 7. Clean workDir
    try { await fs.rm(workDir, { recursive: true, force: true }); } catch (err) { logger.warn({ err }, '[MACHINIST][PIPELINE] Failed to clean workDir'); }

    return { status: 'complete', versions };
  } catch (err) {
    logger.error({ err, tenant_id: job && job.tenant_id, asset_id: job && job.asset_id, batch_id: job && job.batch_id }, '[MACHINIST][PIPELINE] Pipeline failed');
    // Attempt cleanup
    try { await fs.rm(workDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }

    // Create failed records for versions if needed (best-effort)
    // (uploadAndRecord functions already create failed records on upload failure)

    throw err;
  }
}

module.exports = { runMachinistPipeline };
