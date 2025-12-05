/**
 * Safe parse helper for DLQ entries.
 */
function safeParseDLQ(message) {
  try {
    const obj = JSON.parse(message);
    if (!obj || typeof obj !== 'object') return null;
    return obj;
  } catch {
    return null;
  }
}

module.exports = { safeParseDLQ };
