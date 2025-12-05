/**
 * Shared Redis client and queue helpers.
 */
const { createClient } = require('redis');
const config = require('@config');
const { logger: rootLogger } = require('@core/logger');

let client;
let connecting = null;

function attachClientEvents(c) {
  const log = rootLogger.child({ component: 'redis' });
  c.on('connect', () => log.info('Redis connecting'));
  c.on('ready', () => log.info('Redis ready'));
  c.on('end', () => log.warn('Redis connection ended'));
  c.on('reconnecting', () => log.warn('Redis reconnecting'));
  c.on('error', (err) => log.error({ err }, 'Redis error'));
}

/**
 * Ensure redis client exists and is connected.
 * @returns {Promise<import('redis').RedisClientType>}
 */
async function getRedisClient() {
  if (client && client.isOpen) return client;
  if (!client) {
    const urlFromEnv = process.env.REDIS_URL || config.redis.url;
    if (urlFromEnv) {
      try {
        const parsed = new URL(urlFromEnv);
        const isSecure = parsed.protocol === 'rediss:' || process.env.REDIS_TLS === 'true';
        client = createClient({
          url: urlFromEnv,
          socket: {
            tls: isSecure,
            rejectUnauthorized: false,
          },
        });
      } catch (e) {
        // Fallback to host/port if URL parse fails
        client = createClient({
          socket: {
            host: config.redis.host,
            port: config.redis.port,
            tls: process.env.REDIS_TLS === 'true' ? { rejectUnauthorized: false } : undefined,
          },
          password: config.redis.password,
        });
      }
    } else {
      client = createClient({
        socket: {
          host: config.redis.host,
          port: config.redis.port,
          tls: process.env.REDIS_TLS === 'true' ? { rejectUnauthorized: false } : undefined,
        },
        password: config.redis.password,
      });
    }
    attachClientEvents(client);
  }
  if (!client.isOpen) {
    if (!connecting) {
      connecting = client.connect().catch((err) => {
        connecting = null;
        throw err;
      });
    }
    await connecting;
    connecting = null;
  }
  return client;
}

/**
 * Utility to run with connected client.
 * @template T
 * @param {(c: import('redis').RedisClientType) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withRedis(fn) {
  const c = await getRedisClient();
  return fn(c);
}

function safeStringify(obj) {
  try { return JSON.stringify(obj); } catch (e) { return null; }
}

/**
 * Push a job to a queue (RPUSH).
 * @param {string} queueName
 * @param {object} jobData
 */
async function pushJob(queueName, jobData) {
  const log = rootLogger.child({ component: 'redis-queue' });
  const payload = safeStringify(jobData);
  if (payload == null) {
    log.error({ queueName, jobId: jobData && jobData.id }, 'Failed to stringify job');
    throw new Error('Failed to stringify job');
  }
  log.debug({ queueName, jobId: jobData && jobData.id }, 'Enqueue job');
  return withRedis((c) => c.rPush(queueName, payload));
}

/**
 * Pop a job from a queue (LPOP).
 * @param {string} queueName
 * @returns {Promise<object|null>}
 */
async function popJob(queueName) {
  const log = rootLogger.child({ component: 'redis-queue' });
  const raw = await withRedis((c) => c.lPop(queueName));
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    log.debug({ queueName, jobId: obj && obj.id }, 'Dequeue job');
    return obj;
  } catch (err) {
    log.error({ queueName, err }, 'Failed to parse dequeued job');
    return null;
  }
}

/**
 * Requeue a job (RPUSH again).
 * @param {string} queueName
 * @param {object} jobData
 */
async function requeueJob(queueName, jobData) {
  const log = rootLogger.child({ component: 'redis-queue' });
  const payload = safeStringify(jobData);
  if (payload == null) {
    log.error({ queueName, jobId: jobData && jobData.id }, 'Failed to stringify job for requeue');
    throw new Error('Failed to stringify job for requeue');
  }
  log.debug({ queueName, jobId: jobData && jobData.id }, 'Requeue job');
  return withRedis((c) => c.rPush(queueName, payload));
}

module.exports = {
  getRedisClient,
  withRedis,
  pushJob,
  popJob,
  requeueJob,
};
