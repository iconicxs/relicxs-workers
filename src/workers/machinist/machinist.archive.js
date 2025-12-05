/**
 * Hardened preservation archive creator for MACHINIST.
 * Creates a deterministic .tar.gz archive of the workDir,
 * computes SHA256 checksum, checks idempotency, uploads to B2,
 * records asset version, and ensures safety.
 */

const fs = require('fs');
const fse = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const tar = require('tar');
const { uploadFile } = require('../../core/storage');
const { callRpc, supabase } = require('../../core/supabase');
const { sendToDLQ } = require('../../resilience/dlq');
const LIMITS = require('@safety/runtime-limits');

/**
 * Compute SHA256 checksum of a file
 */
function computeChecksum(localPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(localPath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Check if we already have a preservation archive version
 */
async function hasPreservationVersion(assetId) {
  const { data, error } = await supabase
    .from('asset_versions')
    .select('id')
    .eq('asset_id', assetId)
    .eq('purpose', 'preservation')
    .eq('variant', 'original')
    .limit(1);

  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

/**
 * Create manifest.json contents
 */
function buildManifest(job, fileCount, checksum) {
  return {
    tenant_id: job.tenant_id,
    asset_id: job.asset_id,
    batch_id: job.batch_id,
    created_at: new Date().toISOString(),
    file_count: fileCount,
    checksum,
    algorithm: 'sha256',
  };
}

/**
 * Hardened archive creator
 */
async function archiveAssetToGlacier(logger, job, workDir) {
  try {
    const { tenant_id, asset_id } = job;

    logger.info({ tenant_id, asset_id }, "[ARCHIVE] Starting preservation archive creation");

    // 1. Idempotency: if archive exists, skip
    if (await hasPreservationVersion(asset_id)) {
      logger.info({ asset_id }, "[ARCHIVE] Preservation archive already exists. Skipping.");
      return { skipped: true };
    }

    // 2. Validate workDir
    if (!fs.existsSync(workDir)) {
      throw new Error("Archive workDir not found");
    }

    const files = await fse.readdir(workDir);
    if (files.length === 0) {
      throw new Error("Nothing to archive — workDir is empty");
    }

    // 3. Build deterministic archive path
    const archiveName = "preservation.tar.gz";
    const archiveLocal = path.join(workDir, archiveName);
    const archiveRemote = path.posix.join(
      "archive",
      `tenant-${tenant_id}`,
      `asset-${asset_id}`,
      "preservation",
      archiveName
    );

    // 4. Build manifest.json inside temp directory
    const manifestPath = path.join(workDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(
      buildManifest(job, files.length, null),
      null,
      2
    ));

    // Include manifest.json in archive processing set
    const tarFiles = await fse.readdir(workDir);

    // 5. Create tar.gz archive
    logger.info({ archiveLocal }, "[ARCHIVE] Creating tar.gz package");

    await tar.c(
      {
        gzip: true,
        file: archiveLocal,
        cwd: workDir,
        portable: true,
        noMtime: true,
      },
      tarFiles
    );

    // 6. Validate archive size
    const stats = fs.statSync(archiveLocal);
    if (stats.size > LIMITS.MAX_ARCHIVE_BYTES) {
      throw new Error(`Archive too large: ${stats.size} bytes`);
    }

    // 7. Compute checksum
    logger.info("[ARCHIVE] Computing SHA256 checksum");
    const checksum = await computeChecksum(archiveLocal);

    // Update manifest with checksum
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(buildManifest(job, tarFiles.length, checksum), null, 2)
    );

    // 8. Upload to Glacier (via B2 bucket)
    logger.info({ archiveRemote }, "[ARCHIVE] Uploading archive to storage");

    await uploadFile(
      // If you have a glacierBucketId use it. Else use processedArchiveBucketId.
      process.env.GLACIER_BUCKET_ID || process.env.B2_PROCESSED_ARCHIVE_BUCKET_ID,
      archiveRemote,
      archiveLocal,
      "application/gzip"
    );

    // 9. Record asset version
    logger.info("[ARCHIVE] Recording preservation asset_version");

    await callRpc({
      name: "create_asset_version",
      params: {
        asset_id,
        path: archiveRemote,
        version_type: "preservation",
        purpose: "preservation",
        variant: "original",
        checksum,
        checksum_algorithm: "sha256",
        mime_type: "application/gzip",
        status: "complete",
      },
      tenantId: tenant_id,
    });

    logger.info("[ARCHIVE] Preservation archive completed successfully");
    return { status: "complete", path: archiveRemote, checksum };

  } catch (err) {
    logger.error({ err, asset_id: job.asset_id }, "[ARCHIVE] Failed to create preservation archive");

    // Send to DLQ
    try {
      await sendToDLQ(job, "preservation_archive_failed:" + err.message);
    } catch (_) {}

    throw err;
  }
}

module.exports = { archiveAssetToGlacier };
