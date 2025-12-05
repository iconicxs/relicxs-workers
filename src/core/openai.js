const OpenAI = require('openai');
const config = require('./config');
const { logger } = require('./logger');

const client = new OpenAI({ apiKey: config.openai.apiKey });

async function createChatCompletion(body = {}) {
  const model = body.model || config.openai.defaultModel;

  if (config.dryRun) {
    logger.warn('[DRY_RUN] OpenAI.chat.completion skipped');
    return {
      choices: [
        { message: { content: JSON.stringify({ title: 'DRY RUN TITLE', description: 'No OpenAI call executed' }) } },
      ],
    };
  }

  return client.chat.completions.create({
    ...body,
    model,
  });
}

async function createBatchJob(payload = {}) {
  if (config.dryRun) {
    logger.warn('[DRY_RUN] OpenAI.batch.create skipped');
    return {
      id: 'dry_batch_id',
      status: 'completed',
      input_file_id: 'dry_input',
      output_file_id: 'dry_output',
    };
  }
  return client.batches.create(payload);
}

module.exports = {
  openai: client,
  createChatCompletion,
  createBatchJob,
};