class TimeoutError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'TimeoutError';
    this.code = 'TIMEOUT';
  }
}

function withTimeout(promise, ms, msg = 'Operation timed out') {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new TimeoutError(msg)), ms);
    })
  ]).finally(() => clearTimeout(timeout));
}

module.exports = { withTimeout, TimeoutError };
