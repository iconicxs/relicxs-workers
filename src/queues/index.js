/**
 * DEPRECATED: Use namespaced queues instead:
 *  - require('../queues/machinist')
 *  - require('../queues/archivist')
 */
function deprecated() {
	throw new Error('Deprecated queues/index.js. Use namespaced queues: require("@/queues/machinist") or require("@/queues/archivist")');
}

module.exports = {
	instantQueue: { enqueue: deprecated, dequeue: deprecated, requeue: deprecated },
	standardQueue: { enqueue: deprecated, dequeue: deprecated, requeue: deprecated },
	batchQueue: { enqueue: deprecated, dequeue: deprecated, requeue: deprecated },
};
