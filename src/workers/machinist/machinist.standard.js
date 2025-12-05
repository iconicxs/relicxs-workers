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
const { recordJobStart, recordJobEnd } = require('../../job-system/metrics');
const { logStart, logEnd, logFailure } = require('../../resilience/logging');
const { sanitizeExt } = require('@security/sanitize');

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
    let ext = sanitizeExt((job.original_extension || job.extension || job.input_extension || 'jpg'));
    if (!ext) throw new Error('[MACHINIST][STANDARD] Unsafe or unsupported extension');

    const landingPath = path.posix.join('landing', `tenant-${tenantId}`, `batch-${batchId}`, `asset-${assetId}`, `original.${ext}`);
    const inputLocalPath = path.join(workDir, `original.${ext}`);
    await wrap(
      () => withRetry(
        () => downloadFile(config.b2.landingBucketId || config.b2.processedStandardBucketId, landingPath, inputLocalPath),
        { logger, maxRetries: 2, baseDelay: 500, context: { step: 'download-original' } }
      ),
      logger,
      { step: 'download-original' }
    );

    const fileBuf = fs.readFileSync(inputLocalPath);
    await validateImageBuffer(fileBuf);
    const det = detectMime(fileBuf);
    if (!det || !det.mime) throw new Error('UNSUPPORTED_MIME');
    const meta = await sharp(fileBuf).metadata();
    enforceResolution(meta.width, meta.height);

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
      const viewingRemote = path.posix.join(
        'standard',
        `tenant-${tenantId}`,
        `asset-${assetId}`,
        'viewing',
        `${normalizeFilename('viewing')}.jpg`
      );
      try {
        await wrap(
          () => withRetry(
            () => uploadAndRecordViewing({ logger, job, bucketId: config.b2.processedStandardBucketId, remotePath: viewingRemote, localPath: derivatives.viewing.localPath }),
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
      const aiRemote = path.posix.join(
        'standard',
        `tenant-${tenantId}`,
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
        const tnRemote = path.posix.join(
          'standard',
          `tenant-${tenantId}`,
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

    // Optional: future AI metadata support when standard pipeline produces AI data
    try {
      const exifBlock = {}; // No EXIF here; upstream pipeline handles extraction
      const aiBlock = job.ai_metadata || null;

      const merged = await mergeMetadata({ exif: exifBlock, ai: aiBlock, job });

      const manifestLocal = path.join(workDir, 'manifest.json');
      await fse.writeJson(manifestLocal, merged, { spaces: 2 });

      const manifestRemote = path.posix.join(
        'standard',
        `tenant-${tenantId}`,
        `asset-${assetId}`,
        'metadata',
        'manifest.json'
      );

      await uploadMetadata({
        logger,
        job,
        bucketId: config.b2.processedStandardBucketId,
        remotePath: manifestRemote,
        localPath: manifestLocal,
      });
    } catch (err) {
      logger.warn({ err }, '[MACHINIST][STANDARD] failed to build merged manifest');
    }

    const result = { status: 'complete' };
    logEnd(logger, job, result);
    return result;
  } catch (err) {
    logFailure(logger, job, err);
    logger.error({ err, tenant_id: job?.tenant_id, asset_id: job?.asset_id }, '[MACHINIST][STANDARD] Failed');
    try { await sendToDLQ(job, err.message || String(err), logger); } catch (_) {}
    throw err;
  }
  finally {
    try { await recordJobEnd(job); } catch (_) {}
  }
}

module.exports = { processStandardMachinistJob };
