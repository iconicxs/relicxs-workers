function detectMime(buffer) {
  if (!buffer || buffer.length < 12) return { mime: null, extension: null };
  const b = buffer;
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', extension: 'jpg' };
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return { mime: 'image/png', extension: 'png' };
  // TIFF: II*\0 or MM\0*
  if (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) return { mime: 'image/tiff', extension: 'tiff' };
  if (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a) return { mime: 'image/tiff', extension: 'tiff' };
  return { mime: null, extension: null };
}

function validateMime(mime) {
  const allowed = new Set(['image/jpeg', 'image/png', 'image/tiff']);
  if (!mime || !allowed.has(mime)) throw new Error('UNSUPPORTED_MIME');
  return true;
}

function correctExtension(p, extension) {
  const path = require('path');
  const posix = path.posix || path;
  const dir = posix.dirname(p);
  const base = posix.basename(p, posix.extname(p));
  return posix.join(dir, `${base}.${extension.replace(/^\./, '')}`);
}

module.exports = { detectMime, validateMime, correctExtension };
