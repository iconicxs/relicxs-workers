/**
 * Startup checks: config surface, Redis, Supabase connectivity.
 */
const config = require('../core/config');
const { logger } = require('../core/logger');
const { getRedisClient } = require('../core/redis');
const { supabase } = require('../core/supabase');
const { execSync } = require('child_process');

/**
 * Run startup checks and throw on critical failures.
 */
async function runStartupChecks() {
  const log = logger.child({ component: 'startup-checks' });
  log.info({ env: config.env, logLevel: config.logLevel, healthPort: config.healthPort }, 'Starting startup checks');

  if (config.MINIMAL_MODE) {
    console.warn('[CHECK-ENV] MINIMAL_MODE enabled — skipping full env validation');
    return;
  }

  // Env validations (no secrets in logs)
  const missing = [];
  function req(val, name) { if (!val) missing.push(name); }
  req(config.openai.apiKey, 'OPENAI_API_KEY');
  req(config.supabase.url, 'NEXT_PUBLIC_SUPABASE_URL');
  req(config.supabase.serviceKey || config.supabase.serviceRole, 'SUPABASE_SERVICE_KEY');
  // Redis may come from URL; only require host/port/password when URL missing
  if (!config.redis.url) {
    req(config.redis.host, 'REDIS_HOST');
    req(config.redis.port, 'REDIS_PORT');
    // password can be optional for local dev
  }
  req(config.b2.applicationKeyId, 'B2_APPLICATION_KEY_ID');
  req(config.b2.applicationKey, 'B2_APPLICATION_KEY');
  req(config.b2.landingBucketId, 'B2_LANDING_BUCKET_ID');
  req(config.b2.processedStandardBucketId, 'B2_PROCESSED_STANDARD_BUCKET_ID');
  req(config.b2.processedArchiveBucketId, 'B2_PROCESSED_ARCHIVE_BUCKET_ID');
  req(config.b2.filesBucketId, 'B2_FILES_BUCKET_ID');
  // AWS is optional; if missing, Glacier features are disabled
  if (!(config.aws && config.aws.accessKeyId && config.aws.secretAccessKey && config.aws.region && config.aws.archiveBucket)) {
    log.warn('AWS archive not configured; Glacier features disabled');
  }
  if (missing.length) {
    log.error({ missing }, 'Missing required environment variables');
    throw new Error('Startup check failed: Missing env vars');
  }

  // Redis check
  try {
    const client = await getRedisClient();
    const pong = await client.ping();
    log.info({ redis: config.redis.host, pong }, 'Redis PING ok');
  } catch (err) {
    log.error({ err }, 'Redis connectivity failed');
    throw new Error('Startup check failed: Redis');
  }

  // Supabase check (best-effort)
  try {
    // Try a simple RPC if exists, otherwise log and continue.
    const { error } = await supabase.rpc('health_check');
    if (error) {
      log.warn({ error }, 'Supabase health_check RPC not available; skipping');
    } else {
      log.info('Supabase RPC health_check ok');
    }
  } catch (err) {
    // Non-fatal if RPC doesn't exist; but fatal if clearly misconfigured (401/403)
    const status = err && err.status;
    if (status === 401 || status === 403) {
      logger.error({ err }, 'Supabase authentication failed');
      throw new Error('Startup check failed: Supabase authentication');
    }
    logger.warn({ err }, 'Supabase check inconclusive; proceed');
  }

  // DRY_RUN mode (optional)
  if (process.env.DRY_RUN === 'true') {
    console.warn('⚠ DRY_RUN MODE ENABLED — no external calls or DB writes will occur.');
  }

  // Best-effort system dependency hints (non-fatal)
  try {
    execSync('exiftool -ver', { stdio: 'ignore' });
  } catch (_) {
    log.warn('exiftool not found on PATH; EXIF extraction will be skipped. Install via brew (macOS) or apt (Debian/Ubuntu).');
  }

  log.info('Startup checks completed');
}

module.exports = { runStartupChecks };
