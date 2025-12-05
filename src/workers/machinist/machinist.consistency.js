/**
 * MACHINIST CONSISTENCY ENFORCEMENT MODULE
 * ----------------------------------------
 * Provides:
 *   - normalizeExif()
 *   - enforceResolution()
 *   - normalizeFilename()
 */

const MIN_WIDTH = parseInt(process.env.MACHINIST_MIN_WIDTH || "300", 10);
const MIN_HEIGHT = parseInt(process.env.MACHINIST_MIN_HEIGHT || "300", 10);
const MAX_WIDTH = parseInt(process.env.MACHINIST_MAX_WIDTH || "12000", 10);
const MAX_HEIGHT = parseInt(process.env.MACHINIST_MAX_HEIGHT || "12000", 10);

/**
 * Normalize EXIF metadata for consistency.
 * Removes unwanted keys, normalizes cases, and ensures predictable structure.
 */
function normalizeExif(exif) {
  if (!exif || typeof exif !== "object") return {};

  const allowed = [
    "date_time_original",
    "create_date",
    "artist",
    "copyright",
    "camera_model",
    "camera_make",
    "image_width",
    "image_height",
    "mime_type"
  ];

  const out = {};
  for (const key of allowed) {
    if (key in exif) out[key] = exif[key];
  }
  return out;
}

/**
 * Enforce global resolution rules: no tiny images, no extreme images.
 */
function enforceResolution(width, height) {
  if (!width || !height) throw new Error("INVALID_DIMENSIONS");

  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    throw new Error(`IMAGE_TOO_SMALL: requires >= ${MIN_WIDTH}x${MIN_HEIGHT}`);
  }

  if (width > MAX_WIDTH || height > MAX_HEIGHT) {
    throw new Error(`IMAGE_TOO_LARGE: max allowed ${MAX_WIDTH}x${MAX_HEIGHT}`);
  }
}

/**
 * Normalize filenames for deterministic output across ALL workers.
 * Converts spaces, underscores, and camelCase to a unified kebab-case.
 */
function normalizeFilename(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

module.exports = { normalizeExif, enforceResolution, normalizeFilename };
