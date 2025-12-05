#!/usr/bin/env node
/*
  Migrate legacy shared queues to namespaced queues.
  - From: jobs:instant|jobs:standard|jobs:jobgroup
  - To:
    - Machinist: jobs:machinist:{instant,standard,batch}
    - Archivist: jobs:archivist:{instant,standard,jobgroup}
*/
const { getRedisClient } = require('../src/core/redis');

const LEGACY = {
  instant: 'jobs:instant',
  standard: 'jobs:standard',
  jobgroup: 'jobs:jobgroup',
};

const TARGET = {
  archivist: {
    instant: 'jobs:archivist:instant',
    standard: 'jobs:archivist:standard',
    jobgroup: 'jobs:archivist:jobgroup',
  },
  machinist: {
    instant: 'jobs:machinist:instant',
    standard: 'jobs:machinist:standard',
    batch: 'jobs:machinist:batch',
  },
};

function detectWorker(job, legacyKey) {
  const jt = (job && job.job_type && String(job.job_type).toLowerCase()) || '';
  if (jt.includes('archivist')) return 'archivist';
  if (jt.includes('machinist')) return 'machinist';
  if (job && (job.processing_type || job.ai_description_id)) return 'archivist';
  if (job && (job.file_purpose || job.original_extension || job.extension)) return 'machinist';
  // Legacy jobgroup is for archivist by default
  if (legacyKey === LEGACY.jobgroup) return 'archivist';
  return null;
}

function detectPriority(legacyKey) {
  if (legacyKey === LEGACY.instant) return 'instant';
  if (legacyKey === LEGACY.standard) return 'standard';
  if (legacyKey === LEGACY.jobgroup) return 'jobgroup';
  return null;
}

(async () => {
  const redis = await getRedisClient();
  let moved = 0, skipped = 0;
  for (const legacyKey of Object.values(LEGACY)) {
    // Drain until empty
    while (true) {
      const raw = await redis.lPop(legacyKey);
      if (!raw) break;
      let job;
      try { job = JSON.parse(raw); } catch (_) { job = null; }
      if (!job) { skipped++; continue; }
      const worker = detectWorker(job, legacyKey);
      const prio = detectPriority(legacyKey);
      if (!worker || !prio) { skipped++; continue; }
      let targetKey;
      if (worker === 'archivist') {
        targetKey = TARGET.archivist[prio] || TARGET.archivist.standard;
      } else {
        // map legacy jobgroup to machinist batch (reserved)
        targetKey = TARGET.machinist[prio === 'jobgroup' ? 'batch' : prio] || TARGET.machinist.standard;
      }
      await redis.rPush(targetKey, JSON.stringify(job));
      moved++;
    }
  }
  /* eslint-disable no-console */
  console.log(`[migrate-queues] moved=${moved} skipped=${skipped}`);
  process.exit(0);
})().catch((err) => {
  console.error('[migrate-queues] failed', err);
  process.exit(1);
});
