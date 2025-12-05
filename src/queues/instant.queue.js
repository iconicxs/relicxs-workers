// DEPRECATED legacy shared queue helper. Use namespaced queues.
function deprecated() {
  throw new Error('Deprecated queues/instant.queue.js. Use queues/machinist or queues/archivist');
}

module.exports = { enqueue: deprecated, dequeue: deprecated, requeue: deprecated };
