/**
 * OpenAI wrapper for Archivist using configured model.
 */
const OpenAI = require('openai');
const config = require('../../core/config');
const { logger } = require('../../core/logger');

const client = new OpenAI({ apiKey: config.openai.apiKey });

async function retry(fn, { max = 5, base = 200 } = {}) {
  let last;
  for (let i = 0; i < max; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const code = err && (err.status || err.code);
      if (!(code === 429 || (typeof code === 'number' && code >= 500))) break;
      const delay = base * Math.pow(2, i);
      logger.warn({ attempt: i + 1, delay }, '[ARCHIVIST][OPENAI] Retrying');
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw last;
}

/**
 * Execute chat completion with image and return { text, usage }.
 * @param {{ messages: any[] }} args
 */
async function runArchivistChat({ messages }) {
  const model = config.openai.defaultModel;
  const res = await retry(() => client.chat.completions.create({ model, messages }));
  const choice = res.choices && res.choices[0];
  const text = choice && (choice.message.content || '').trim();
  const usage = res.usage || { prompt_tokens: 0, completion_tokens: 0 };
  return { text, usage, model };
}

module.exports = { runArchivistChat };
