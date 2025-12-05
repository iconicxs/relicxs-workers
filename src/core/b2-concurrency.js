const { logger } = require('@core/logger');

const limit = parseInt(process.env.B2_CONCURRENCY_LIMIT || '5', 10);

let active = 0;
const queue = [];

function runNext() {
  if (active >= limit) return;
  const item = queue.shift();
  if (!item) return;

  active += 1;

  const { taskFn, resolve, reject, label } = item;
  const start = Date.now();

  Promise.resolve()
    .then(() => taskFn())
    .then((result) => {
      const duration = Date.now() - start;
      logger.debug({ label, duration, active }, '[B2] task complete');
      resolve(result);
    })
    .catch((err) => {
      const duration = Date.now() - start;
      logger.warn({ label, duration, active, err }, '[B2] task failed');
      reject(err);
    })
    .finally(() => {
      active -= 1;
      runNext();
    });
}

function withB2Limit(taskFn, label = 'b2-task') {
  return new Promise((resolve, reject) => {
    queue.push({ taskFn, resolve, reject, label });
    runNext();
  });
}

module.exports = { withB2Limit };
