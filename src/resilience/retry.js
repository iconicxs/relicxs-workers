/**
 * Exponential backoff retry wrapper with jitter.
 */
function jitterDelay(base, jitter = 0.3) {
  const jitterAmt = base * jitter;
  const rand = (Math.random() * jitterAmt * 2) - jitterAmt;
  return Math.max(0, Math.round(base + rand));
}

/**
 * withRetry(fn, { maxRetries=3, baseDelay=500, maxDelay=4000, maxElapsedTime, jitter=0.3, logger, context={}})
 */
async function withRetry(fn, opts = {}) {
  const { maxRetries = 3, baseDelay = 500, maxDelay = 4000, maxElapsedTime, jitter = 0.3, logger = console, context = {} } = opts;
  let attempt = 0;
  let lastErr;
  const start = Date.now();
  while (attempt <= maxRetries) {
    try {
      if (attempt > 0) logger.info({ attempt, context }, '[RESILIENCE] Retry attempt');
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries) break;
      if (typeof maxElapsedTime === 'number' && Date.now() - start >= maxElapsedTime) break;
      const delay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt));
      const finalDelay = jitterDelay(delay, jitter);
      logger.warn({ attempt: attempt + 1, delay: finalDelay, err: err.message, context }, '[RESILIENCE] Operation failed, retrying');
      await new Promise((r) => setTimeout(r, finalDelay));
      attempt += 1;
    }
  }
  const e = new Error(`[RESILIENCE] All retries failed: ${lastErr && lastErr.message}`);
  e.cause = lastErr;
  throw e;
}

module.exports = { withRetry };
