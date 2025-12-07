/**
 * Worker health collector
 */
const os = require('os');
const { getRedisClient } = require('../core/redis');
const {
  MACHINIST_QUEUE_INSTANT,
  MACHINIST_QUEUE_STANDARD,
  MACHINIST_QUEUE_JOBGROUP,
  ARCHIVIST_QUEUE_INSTANT,
  ARCHIVIST_QUEUE_STANDARD,
  ARCHIVIST_QUEUE_JOBGROUP,
} = require('../priorities/priority.constants');

async function getWorkerHealth() {
  const redis = await getRedisClient();
  let redisConnected = !!redis.isOpen;
  const queueDepths = { archivist: {}, machinist: {} };
  try {
    // Archivist queues
    queueDepths.archivist.instant = await redis.lLen(ARCHIVIST_QUEUE_INSTANT);
    queueDepths.archivist.standard = await redis.lLen(ARCHIVIST_QUEUE_STANDARD);
    queueDepths.archivist.jobgroup = await redis.lLen(ARCHIVIST_QUEUE_JOBGROUP);
    // Machinist queues
    queueDepths.machinist.instant = await redis.lLen(MACHINIST_QUEUE_INSTANT);
    queueDepths.machinist.standard = await redis.lLen(MACHINIST_QUEUE_STANDARD);
    queueDepths.machinist.batch = await redis.lLen(MACHINIST_QUEUE_JOBGROUP);
  } catch (err) {
    redisConnected = false;
  }

  const mem = process.memoryUsage();
  const cpus = os.cpus().length;
  const load = os.loadavg()[0];
  const cpuPercent = Math.round((load / cpus) * 100 * 100) / 100;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  return {
    redis_connected: redisConnected,
    queue_depths: queueDepths,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      system: {
        total: totalMem,
        free: freeMem,
        used: usedMem,
      },
    },
    cpu_load: cpuPercent,
    uptime: Math.round(process.uptime()),
  };
}

module.exports = { getWorkerHealth };
