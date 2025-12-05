/**
 * Central configuration loader and validator.
 * Loads .env and exports a frozen config object.
 */
const dotenv = require('dotenv');
// Load .env BEFORE reading any env vars so MINIMAL_MODE can be set there
dotenv.config();
const MINIMAL_MODE = process.env.MINIMAL_MODE === 'true';

function requireEnv(name, opts = {}) {
  const val = process.env[name];
  if (!val || (opts.trim !== false && String(val).trim() === '')) {
    throw new Error(`[CONFIG] Missing env: ${name}`);
  }
  return val;
}

function optionalEnv(name, def) {
  const val = process.env[name];
  if (val === undefined || val === '') return def;
  return val;
}

const NODE_ENV = optionalEnv('NODE_ENV', 'production');
const LOG_LEVEL = optionalEnv('LOG_LEVEL', 'info');

const REDIS_URL = optionalEnv('REDIS_URL');
const REDIS_HOST = optionalEnv('REDIS_HOST');
const REDIS_PORT = optionalEnv('REDIS_PORT') ? parseInt(optionalEnv('REDIS_PORT'), 10) : null;
const REDIS_PASSWORD = optionalEnv('REDIS_PASSWORD');
const REDIS_TLS = optionalEnv('REDIS_TLS') === 'true';

const SUPABASE_URL = MINIMAL_MODE ? optionalEnv('NEXT_PUBLIC_SUPABASE_URL') : requireEnv('NEXT_PUBLIC_SUPABASE_URL');
// Support either service key or service role (preferred) without hard-requiring one at config load
const SUPABASE_SERVICE_KEY = optionalEnv('SUPABASE_SERVICE_KEY');
const SUPABASE_SERVICE_ROLE = optionalEnv('SUPABASE_SERVICE_ROLE');

const OPENAI_API_KEY = MINIMAL_MODE ? optionalEnv('OPENAI_API_KEY') : requireEnv('OPENAI_API_KEY');
const OPENAI_DEFAULT_MODEL = optionalEnv('OPENAI_MODEL', 'gpt-4o');

const B2_APPLICATION_KEY_ID = MINIMAL_MODE ? optionalEnv('B2_APPLICATION_KEY_ID') : requireEnv('B2_APPLICATION_KEY_ID');
const B2_APPLICATION_KEY = MINIMAL_MODE ? optionalEnv('B2_APPLICATION_KEY') : requireEnv('B2_APPLICATION_KEY');
const B2_LANDING_BUCKET_ID = MINIMAL_MODE ? optionalEnv('B2_LANDING_BUCKET_ID') : requireEnv('B2_LANDING_BUCKET_ID');
const B2_PROCESSED_STANDARD_BUCKET_ID = MINIMAL_MODE ? optionalEnv('B2_PROCESSED_STANDARD_BUCKET_ID') : requireEnv('B2_PROCESSED_STANDARD_BUCKET_ID');
const B2_PROCESSED_ARCHIVE_BUCKET_ID = MINIMAL_MODE ? optionalEnv('B2_PROCESSED_ARCHIVE_BUCKET_ID') : requireEnv('B2_PROCESSED_ARCHIVE_BUCKET_ID');
const B2_FILES_BUCKET_ID = MINIMAL_MODE ? optionalEnv('B2_FILES_BUCKET_ID') : requireEnv('B2_FILES_BUCKET_ID');

// AWS / Glacier
// AWS is optional; when unset, Glacier features are disabled gracefully
const AWS_ACCESS_KEY_ID = optionalEnv('AWS_ACCESS_KEY_ID');
const AWS_SECRET_ACCESS_KEY = optionalEnv('AWS_SECRET_ACCESS_KEY');
const AWS_REGION = optionalEnv('AWS_REGION');
const AWS_ARCHIVE_BUCKET = optionalEnv('AWS_ARCHIVE_BUCKET');

const HEALTH_PORT = parseInt(optionalEnv('HEALTH_PORT', '8081'), 10);
const OPENAI_MOCK_DIR = optionalEnv('OPENAI_MOCK_DIR');
const SAAS_WEBHOOK_URL_JOBGROUP = optionalEnv('SAAS_WEBHOOK_URL_JOBGROUP');

const _config = {
  env: NODE_ENV,
  logLevel: LOG_LEVEL,
  redis: {
    url: REDIS_URL || null,
    host: REDIS_HOST || null,
    port: REDIS_PORT,
    password: REDIS_PASSWORD || null,
    tls: REDIS_TLS,
  },
  supabase: {
    url: SUPABASE_URL,
    serviceKey: SUPABASE_SERVICE_KEY,
    serviceRole: SUPABASE_SERVICE_ROLE,
  },
  openai: {
    apiKey: OPENAI_API_KEY,
    defaultModel: OPENAI_DEFAULT_MODEL,
  },
  b2: {
    applicationKeyId: B2_APPLICATION_KEY_ID,
    applicationKey: B2_APPLICATION_KEY,
    landingBucketId: B2_LANDING_BUCKET_ID,
    processedStandardBucketId: B2_PROCESSED_STANDARD_BUCKET_ID,
    processedArchiveBucketId: B2_PROCESSED_ARCHIVE_BUCKET_ID,
    filesBucketId: B2_FILES_BUCKET_ID,
  },
  aws: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
    region: AWS_REGION,
    archiveBucket: AWS_ARCHIVE_BUCKET,
  },
  healthPort: HEALTH_PORT,
  saasWebhookJobgroup: SAAS_WEBHOOK_URL_JOBGROUP,
  openaiMockDirectory: OPENAI_MOCK_DIR || null,
  dryRun: process.env.DRY_RUN === 'true',
  MINIMAL_MODE,
};

const config = Object.freeze(_config);

module.exports = config;
