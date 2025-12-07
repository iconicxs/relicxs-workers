const fs = require('fs');
const path = require('path');
const os = require('os');

// Prefer a writable directory outside the source tree
const LOG_DIR = process.env.JOBGROUP_AUDIT_LOG_DIR
  || process.env.LOG_DIR
  || path.join(os.tmpdir(), 'relicxs-jobgroup-logs');

function ensureDirSafe(dir) {
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (_) {}
}

/**
 * Best-effort audit logger. Never throws.
 * @param {Record<string, any>} entry
 * @returns {boolean} success
 */
function writeJobgroupAudit(entry) {
  try {
    ensureDirSafe(LOG_DIR);
    const date = new Date().toISOString().slice(0, 10);
    const logPath = path.join(LOG_DIR, `jobgroup-${date}.log`);
    let payload;
    try { payload = JSON.stringify(entry); } catch (_) { payload = String(entry); }
    const line = `[${new Date().toISOString()}] ${payload}\n`;
    fs.appendFileSync(logPath, line);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { writeJobgroupAudit };
