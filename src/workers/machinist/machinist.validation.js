const sharp = require('sharp');
const ValidationError = require('../../errors/ValidationError');

function isValidMagic(buffer) {
  if (!buffer || buffer.length < 4) return false;
  const b = buffer;
  // JPEG, PNG, TIFF signatures
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)) return true;
  return false;
}

async function validateImageBuffer(buffer) {
  try {
    if (!buffer || buffer.length === 0) throw new ValidationError('CORRUPTED_IMAGE');
    if (!isValidMagic(buffer)) throw new ValidationError('CORRUPTED_IMAGE');
    const meta = await sharp(buffer).metadata();
    const minW = parseInt(process.env.MIN_IMAGE_WIDTH || '64', 10);
    const minH = parseInt(process.env.MIN_IMAGE_HEIGHT || '64', 10);
    if (!meta || !meta.width || !meta.height) throw new ValidationError('CORRUPTED_IMAGE');
    if (meta.width < minW || meta.height < minH) throw new ValidationError('CORRUPTED_IMAGE');
    return meta;
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError('CORRUPTED_IMAGE');
  }
}

module.exports = { validateImageBuffer };
