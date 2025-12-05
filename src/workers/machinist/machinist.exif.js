/**
 * Extract EXIF metadata using ExifTool (child_process.exec)
 */
const { exec, execSync } = require('child_process');
const fs = require('fs');
const { withTimeout } = require('@safety/with-timeout');
const LIMITS = require('@safety/runtime-limits');

/**
 * Run exiftool and return parsed JSON metadata object for the input file.
 * @param {string} inputPath
 * @returns {Promise<Record<string, any>>}
 */
function extractExifMetadata(inputPath) {
  return new Promise((resolve, reject) => {
    if (!inputPath || typeof inputPath !== 'string') {
      return reject(new Error('[MACHINIST][EXIF] inputPath must be a string'));
    }

    if (!fs.existsSync(inputPath)) {
      return reject(new Error(`[MACHINIST][EXIF] file not found: ${inputPath}`));
    }

    // Gate: if exiftool binary is not available on the host, skip gracefully
    let hasExiftool = false;
    try {
      execSync('exiftool -ver', { stdio: 'ignore' });
      hasExiftool = true;
    } catch (_) {
      hasExiftool = false;
    }
    if (!hasExiftool) {
      // Soft-skip: return empty metadata without error so pipelines continue
      return resolve({});
    }

    // Run exiftool with JSON output using a timeout guard
    let buffer = '';
    const child = exec(`exiftool -json ${inputPath}`);

    withTimeout(
      new Promise((res, rej) => {
        child.stdout.on('data', (d) => (buffer += d));
        child.on('exit', (code) => {
          if (code !== 0) return rej(new Error(`Exiftool exit code ${code}`));
          return res(buffer);
        });
        child.on('error', rej);
      }),
      LIMITS.EXIF_TIMEOUT_MS,
      'EXIFTool timed out'
    )
      .then((out) => {
        try {
          const parsed = JSON.parse(out);
          const meta = Array.isArray(parsed) ? parsed[0] || {} : parsed;
          return resolve(meta);
        } catch (parseErr) {
          return reject(new Error(`[MACHINIST][EXIF] Failed to parse exiftool JSON: ${parseErr.message}`));
        }
      })
      .catch((err) => {
        try { child.kill('SIGKILL'); } catch (_) {}
        return reject(new Error(`[MACHINIST][EXIF] exiftool execution failed: ${err.message}`));
      });
  });
}

module.exports = { extractExifMetadata };
