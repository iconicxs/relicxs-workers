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

  // Helper: pick first non-empty from candidate keys
  const pick = (...keys) => {
    for (const k of keys) {
      if (exif[k] !== undefined && exif[k] !== null && String(exif[k]).trim() !== '') return exif[k];
    }
    return null;
  };

  // Core identity
  const title = pick('Title', 'XPTitle', 'Headline', 'ObjectName');
  const description = pick('Description', 'ImageDescription', 'Caption-Abstract', 'XPComment');
  const creator = pick('Creator', 'Artist', 'By-line');
  const copyright = pick('Rights', 'Copyright');

  // Capture timing
  const date_time_original = pick('DateTimeOriginal');
  const create_date = pick('CreateDate');
  const timezone_offset = pick('OffsetTimeOriginal', 'OffsetTime');

  // Camera / lens
  const camera_make = pick('Make');
  const camera_model = pick('Model');
  const lens_make = pick('LensMake');
  const lens_model = pick('LensModel', 'LensID');

  // Exposure
  const exposure_time = pick('ExposureTime');
  const f_number = exif.FNumber != null ? Number(exif.FNumber) : null;
  const iso = exif.ISO != null ? Number(exif.ISO) : null;
  const focal_length = pick('FocalLength');
  const exposure_program = pick('ExposureProgram');
  const metering_mode = pick('MeteringMode');
  const flash = pick('Flash');

  // Image geometry
  const image_width = exif.ImageWidth != null ? Number(exif.ImageWidth) : null;
  const image_height = exif.ImageHeight != null ? Number(exif.ImageHeight) : null;
  const orientation = pick('Orientation');

  // Color / bit depth
  const color_space = pick('ColorSpace', 'ProfileDescription');
  let bit_depth = null;
  if (typeof exif.BitsPerSample === 'number') bit_depth = exif.BitsPerSample;
  else if (Array.isArray(exif.BitsPerSample)) {
    const first = parseInt(exif.BitsPerSample[0], 10);
    if (!isNaN(first)) bit_depth = first;
  } else if (typeof exif.BitDepth === 'number') bit_depth = exif.BitDepth;

  // Software
  const software = pick('Software');
  const processing_software = pick('CreatorTool');

  // MIME (if present)
  const mime_type = pick('MIMEType', 'MimeType');

  const out = {
    identity: { title, description, creator, copyright },
    capture: { date_time_original, create_date, timezone_offset },
    camera: { camera_make, camera_model, lens_make, lens_model },
    exposure: { exposure_time, f_number, iso, focal_length, exposure_program, metering_mode, flash },
    image: { image_width, image_height, orientation, color_space, bit_depth },
    software: { software, processing_software },
    file: { mime_type },
  };

  // Remove nulls for cleanliness
  const prune = (obj) => Object.fromEntries(Object.entries(obj).filter(([,v]) => v !== null && v !== undefined));
  out.identity = prune(out.identity);
  out.capture = prune(out.capture);
  out.camera = prune(out.camera);
  out.exposure = prune(out.exposure);
  out.image = prune(out.image);
  out.software = prune(out.software);
  out.file = prune(out.file);

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
