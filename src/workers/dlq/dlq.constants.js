/**
 * DLQ Queue Names
 */
module.exports = {
  DLQ_QUEUE: 'image-processing:failed',
  DLQ_RETRY_QUEUE: 'image-processing:retry',
  DLQ_MAX_RETRIES: 3,
  DLQ_RETRY_DELAY_MS: 15_000, // 15 seconds delay before retry
};
