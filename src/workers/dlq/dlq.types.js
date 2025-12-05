/**
 * Standardized DLQ entry.
 */
class DLQEntry {
  constructor({ job, error, ts }) {
    this.job = job || null;
    this.error = error || 'unknown';
    this.ts = ts || Date.now();
  }
}

module.exports = { DLQEntry };
