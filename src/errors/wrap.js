const ValidationError = require('@errors/ValidationError');

/**
 * Centralized error wrapper to log and rethrow.
 * Supports both default export and named `.wrap` for compatibility.
 */
function wrap(fn, logger, context = {}) {
  return (async () => {
    try {
      return await fn();
    } catch (err) {
      logger.error({ err, context }, '[ERROR] Wrapped failure');
      throw err;
    }
  })();
}

module.exports = wrap;
module.exports.wrap = wrap;
