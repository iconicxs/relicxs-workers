/**
 * MACHINIST METADATA FUSION MODULE
 * --------------------------------
 * Produces a deterministic merged metadata block:
 *   - Normalized EXIF (already sanitized upstream)
 *   - AI metadata (optional)
 *   - System metadata (tenant, asset, version timestamps)
 *   - Stable key ordering for reproducibility
 */

const crypto = require('crypto');

/**
 * Canonical key ordering to ensure stable JSON output.
 */
const ORDER = [
  "tenant_id",
  "asset_id",
  "batch_id",
  "checksum",
  "checksum_algorithm",
  "created_at",
  "source",
  "exif",
  "ai",
];

/**
 * Sort object keys alphabetically.
 */
function sortKeys(obj) {
  return Object.keys(obj)
    .sort()
    .reduce((acc, key) => {
      acc[key] = obj[key];
      return acc;
    }, {});
}

/**
 * Create merged metadata block (EXIF + AI).
 */
async function mergeMetadata({ exif = {}, ai = null, job }) {
  const now = new Date().toISOString();

  const merged = {
    tenant_id: job?.tenant_id || null,
    asset_id: job?.asset_id || null,
    batch_id: job?.batch_id || null,
    checksum: null, // filled in later if needed
    checksum_algorithm: "sha256",
    created_at: now,
    source: "machinist",
    exif: sortKeys(exif || {}),
    ai: ai ? sortKeys(ai) : null,
  };

  // Reorder keys deterministically
  const out = {};
  for (const k of ORDER) {
    if (merged[k] !== undefined) out[k] = merged[k];
  }

  return out;
}

module.exports = { mergeMetadata };
