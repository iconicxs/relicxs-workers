/**
 * Structured logging via pino.
 */
const pino = require('pino');
const config = require('@config');

const base = {
	service: 'relicxs-workers',
	env: config.env,
};

const logger = pino({ level: config.logLevel, base });

/**
 * Create a child logger with extra metadata.
 * @param {Record<string, any>} meta
 */
function createChildLogger(meta = {}) {
	return logger.child(meta);
}

module.exports = { logger, createChildLogger };
