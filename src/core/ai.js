/**
 * OpenAI wrapper with simple retry and backoff.
 */
const OpenAI = require('openai');
const config = require('./config');
const { logger } = require('./logger');

const openaiClient = new OpenAI({ apiKey: config.openai.apiKey });

async function retryWithBackoff(fn, { maxAttempts = 5, baseMs = 200 } = {}) {
	let lastErr;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			const status = err && (err.status || err.code);
			const retriable = status === 429 || (typeof status === 'number' && status >= 500);
			if (!retriable || attempt === maxAttempts) break;
			const delay = baseMs * Math.pow(2, attempt - 1);
			logger.warn({ attempt, delay, status }, 'OpenAI call failed, retrying');
			await new Promise((r) => setTimeout(r, delay));
		}
	}
	if (lastErr) {
		const pref = '[OPENAI_ERROR] ';
		const msg = lastErr && lastErr.message ? lastErr.message : String(lastErr);
		const e = new Error(pref + msg);
		e.cause = lastErr;
		throw e;
	}
}

/**
 * Call Chat Completions API
 * @param {{ model?: string, messages: Array<any>, responseFormat?: any }} args
 */
async function callChat({ model, messages, responseFormat } = {}) {
	const m = model || config.openai.defaultModel;
	return retryWithBackoff(async () => {
		const res = await openaiClient.chat.completions.create({
			model: m,
			messages,
			response_format: responseFormat,
		});
		return res;
	});
}

/**
 * Call Vision-capable model
 * @param {{ model?: string, messages: Array<any> }} args
 */
async function callVision({ model, messages } = {}) {
	const m = model || config.openai.defaultModel;
	return retryWithBackoff(async () => {
		const res = await openaiClient.chat.completions.create({
			model: m,
			messages,
		});
		return res;
	});
}

/**
 * Placeholder for Batch API integration
 */
async function callBatch(/* args */) {
	throw new Error('Not implemented yet');
}

module.exports = { openaiClient, callChat, callVision, callBatch };
