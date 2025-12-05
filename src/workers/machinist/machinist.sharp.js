/**
 * Image derivative generation using Sharp.
 */
const sharp = require('sharp');
const path = require('path');
const fse = require('fs-extra');
const { withTimeout } = require('@safety/with-timeout');
const LIMITS = require('@safety/runtime-limits');

/**
 * Ensure directory exists
 * @param {string} p
 */
function ensureDir(p) {
  fse.ensureDirSync(p);
}

/**
 * Generate derivatives for a given input image.
 * @param {object} params
 * @param {import('pino').Logger} params.logger
 * @param {object} params.job
 * @param {string} params.inputPath
 * @param {string} params.workDir
 */
async function generateDerivatives({ logger, job, inputPath, workDir }) {
  if (!inputPath || !workDir) throw new Error('[MACHINIST][SHARP] inputPath and workDir required');
  ensureDir(workDir);

  const results = {
    original: null,
    viewing: null,
    ai: null,
    thumbnails: [],
  };

  // Read metadata
  let meta;
  try {
    meta = await sharp(inputPath).metadata();
  } catch (err) {
    throw new Error(`[MACHINIST][SHARP] sharp metadata failed: ${err.message}`);
  }

  function enforceImageDimensions(metadata) {
    if (
      (metadata.width && metadata.width > LIMITS.SHARP_MAX_DIMENSION) ||
      (metadata.height && metadata.height > LIMITS.SHARP_MAX_DIMENSION) ||
      (metadata.width && metadata.height && metadata.width * metadata.height > LIMITS.SHARP_MAX_PIXELS)
    ) {
      throw new Error('Image too large to process safely');
    }
  }

  enforceImageDimensions(meta);

  const ext = path.extname(inputPath) || '.jpg';
  const baseName = `asset-${job.asset_id}`;

  // Always expose original info (we can upload from inputPath)
  results.original = { localPath: inputPath, width: meta.width || null, height: meta.height || null, mimeType: meta.format || null };

  // Viewing: max 2000px, JPEG quality 85
  const viewingPath = path.join(workDir, `viewing.jpg`);
  try {
    const viewing = sharp(inputPath).rotate();
    const vw = meta.width || null;
    const vh = meta.height || null;
    let pipeline = viewing;
    if (vw && vw > 2000) pipeline = pipeline.resize({ width: 2000 });
    await withTimeout(
      pipeline.jpeg({ quality: 85 }).toFile(viewingPath),
      LIMITS.SHARP_TIMEOUT_MS,
      'Sharp processing timeout'
    );
    const viewingMeta = await sharp(viewingPath).metadata();
    results.viewing = { localPath: viewingPath, width: viewingMeta.width, height: viewingMeta.height };
  } catch (err) {
    logger.error({ err }, '[MACHINIST][SHARP] Failed to generate viewing image');
    throw new Error('sharp_derivative_failed::viewing');
  }

  // AI version only for preservation/viewing purposes
  const purpose = (job.file_purpose || 'viewing').toLowerCase();
  if (purpose === 'preservation' || purpose === 'viewing') {
    const aiPath = path.join(workDir, `ai_version.jpg`);
    try {
      await withTimeout(
        sharp(inputPath)
          .resize({ width: 768, height: 768, fit: 'contain', background: { r: 255, g: 255, b: 255 } })
          .jpeg({ quality: 80 })
          .toFile(aiPath),
        LIMITS.SHARP_TIMEOUT_MS,
        'Sharp processing timeout'
      );
      const aiMeta = await sharp(aiPath).metadata();
      results.ai = { localPath: aiPath, width: aiMeta.width, height: aiMeta.height };
    } catch (err) {
      logger.error({ err }, '[MACHINIST][SHARP] Failed to generate AI image');
      throw new Error('sharp_derivative_failed::ai');
    }
  }

  // Thumbnails: 200,400,800
  const thumbDefs = [
    { label: 'small', width: 200 },
    { label: 'medium', width: 400 },
    { label: 'large', width: 800 },
  ];
  for (const def of thumbDefs) {
    const tnPath = path.join(workDir, `${def.label}.jpg`);
    try {
      await withTimeout(
        sharp(inputPath)
          .resize({ width: def.width })
          .jpeg({ quality: 80 })
          .toFile(tnPath),
        LIMITS.SHARP_TIMEOUT_MS,
        'Sharp processing timeout'
      );
      const tnMeta = await sharp(tnPath).metadata();
      results.thumbnails.push({ size: def.label, localPath: tnPath, width: tnMeta.width, height: tnMeta.height });
    } catch (err) {
      logger.error({ err, size: def.label }, '[MACHINIST][SHARP] Failed to generate thumbnail');
      throw new Error('sharp_derivative_failed::thumbnail');
    }
  }

  return results;
}

module.exports = { generateDerivatives };
