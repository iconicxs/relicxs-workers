// DEPRECATED legacy shared queue helper. Use namespaced queues.
function deprecated() {
  throw new Error('Deprecated queues/standard.queue.js. Use queues/machinist or queues/archivist');
}

module.exports = { enqueue: deprecated, dequeue: deprecated, requeue: deprecated };
