/**
 * Canonical queue names (namespaced) for all workers.
 */

// Namespaced queues per worker to prevent cross-consumption
const MACHINIST_QUEUE_INSTANT = 'jobs:machinist:instant';
const MACHINIST_QUEUE_STANDARD = 'jobs:machinist:standard';

const ARCHIVIST_QUEUE_INSTANT = 'jobs:archivist:instant';
const ARCHIVIST_QUEUE_STANDARD = 'jobs:archivist:standard';
const ARCHIVIST_QUEUE_JOBGROUP = 'jobs:archivist:jobgroup';

// Explicit maps per worker type for router convenience
const MACHINIST = {
  INSTANT: MACHINIST_QUEUE_INSTANT,
  STANDARD: MACHINIST_QUEUE_STANDARD,
};

const ARCHIVIST = {
  INSTANT: ARCHIVIST_QUEUE_INSTANT,
  STANDARD: ARCHIVIST_QUEUE_STANDARD,
  JOBGROUP: ARCHIVIST_QUEUE_JOBGROUP,
};
module.exports = {
  MACHINIST_QUEUE_INSTANT, MACHINIST_QUEUE_STANDARD,
  ARCHIVIST_QUEUE_INSTANT, ARCHIVIST_QUEUE_STANDARD, ARCHIVIST_QUEUE_JOBGROUP,
  MACHINIST, ARCHIVIST,
};
