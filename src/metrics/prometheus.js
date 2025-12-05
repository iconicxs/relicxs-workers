/**
 * PROMETHEUS METRICS EXPORTER
 * ---------------------------
 * Unified metrics registry for Relicxs workers.
 */

const client = require('prom-client');

// Main registry
const registry = new client.Registry();

// Add default Node.js metrics (CPU, memory, event loop)
client.collectDefaultMetrics({ register: registry });

/**
 * Custom metrics
 */

// Running jobs gauge
const runningJobs = new client.Gauge({
  name: 'relicxs_jobs_running',
  help: 'Number of jobs currently running',
  labelNames: ['worker', 'priority'],
});

// Job duration histogram
const jobDuration = new client.Histogram({
  name: 'relicxs_job_duration_seconds',
  help: 'Execution duration of jobs',
  labelNames: ['worker', 'priority'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
});

// Queue depth gauge
const queueDepth = new client.Gauge({
  name: 'relicxs_queue_depth',
  help: 'Queue depth per priority',
  labelNames: ['worker', 'priority'],
});

// DLQ failures counter
const dlqFailures = new client.Counter({
  name: 'relicxs_dlq_failures_total',
  help: 'Total number of jobs sent to Dead Letter Queue',
  labelNames: ['worker', 'reason'],
});

// Register all
registry.registerMetric(runningJobs);
registry.registerMetric(jobDuration);
registry.registerMetric(queueDepth);
registry.registerMetric(dlqFailures);

module.exports = {
  registry,
  runningJobs,
  jobDuration,
  queueDepth,
  dlqFailures,
};
