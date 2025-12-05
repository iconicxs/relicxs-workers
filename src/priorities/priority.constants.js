/**
 * Canonical queue names for all workers.
 */

// Legacy (deprecated) shared queues — do not use for new code
const QUEUE_INSTANT = 'jobs:instant';
const QUEUE_STANDARD = 'jobs:standard';
const QUEUE_JOBGROUP = 'jobs:jobgroup';

// Namespaced queues per worker to prevent cross-consumption
const MACHINIST_QUEUE_INSTANT = 'jobs:machinist:instant';
const MACHINIST_QUEUE_STANDARD = 'jobs:machinist:standard';
const MACHINIST_QUEUE_JOBGROUP = 'jobs:machinist:batch';

const ARCHIVIST_QUEUE_INSTANT = 'jobs:archivist:instant';
const ARCHIVIST_QUEUE_STANDARD = 'jobs:archivist:standard';
const ARCHIVIST_QUEUE_JOBGROUP = 'jobs:archivist:jobgroup';

// Back-compat object used by queue helpers
const QUEUES = {
  INSTANT: QUEUE_INSTANT,
  STANDARD: QUEUE_STANDARD,
  BATCH: QUEUE_JOBGROUP,
};
// Explicit maps per worker type for router convenience
const MACHINIST = {
  INSTANT: MACHINIST_QUEUE_INSTANT,
  STANDARD: MACHINIST_QUEUE_STANDARD,
  BATCH: MACHINIST_QUEUE_JOBGROUP,
};

const ARCHIVIST = {
  INSTANT: ARCHIVIST_QUEUE_INSTANT,
  STANDARD: ARCHIVIST_QUEUE_STANDARD,
  JOBGROUP: ARCHIVIST_QUEUE_JOBGROUP,
};
module.exports = {
  // legacy
  QUEUES, QUEUE_INSTANT, QUEUE_STANDARD, QUEUE_JOBGROUP,
  // namespaced
  MACHINIST_QUEUE_INSTANT, MACHINIST_QUEUE_STANDARD, MACHINIST_QUEUE_JOBGROUP,
  ARCHIVIST_QUEUE_INSTANT, ARCHIVIST_QUEUE_STANDARD, ARCHIVIST_QUEUE_JOBGROUP,
  MACHINIST, ARCHIVIST
};
