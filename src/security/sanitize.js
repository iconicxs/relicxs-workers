const ValidationError = require('@errors/ValidationError');

const EXT_WHITELIST = ['jpg', 'jpeg', 'png', 'tiff', 'tif']; // allow short TIFF extension
const SAFE_EXTS = new Set(EXT_WHITELIST);
const FILENAME_RE = /^[A-Za-z0-9_.-]+$/;

function sanitizeString(v, { max = 0 } = {}) {
  if (typeof v !== 'string') return '';
  let s = v.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

function sanitizeTitle(v, { max = 150 } = {}) {
  return sanitizeString(v, { max });
}

function sanitizeFilename(name) {
  const s = sanitizeString(name, { max: 255 });
  if (s.includes('..') || s.includes('/') || s.includes('\\')) return '';
  if (!FILENAME_RE.test(s)) return '';
  return s;
}

function sanitizeExt(ext) {
  const clean = String(ext || '').replace(/^\./, '').toLowerCase();
  if (!SAFE_EXTS.has(clean)) return '';
  return clean;
}

function sanitizeJson(obj) {
  try { JSON.stringify(obj); return obj; } catch { return {}; }
}

module.exports = {
  EXT_WHITELIST,
  sanitizeString,
  sanitizeTitle,
  sanitizeFilename,
  sanitizeExt,
  sanitizeJ