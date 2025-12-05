const fetch = require('node-fetch');
const config = require('@config');
const { createChildLogger } = require('@core/logger');

const logger = createChildLogger({ module: 'jobgroup-events' });

const WEBHOOK = config.saasWebhookJobgroup || null;

async function postEvent(event, payload) {
  if (!WEBHOOK) {
    logger.warn('Webhook disabled — no SAAS_WEBHOOK_URL_JOBGROUP set');
    return;
  }

  try {
    await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, payload }),
    });
  } catch (err) {
    logger.error({ err }, 'Webhook failed');
  }
}

module.exports = {
  emitJobgroupCreated: (j) => postEvent('jobgroup.created', j),
  emitJobgroupCompleted: (j) => postEvent('jobgroup.completed', j),
  emitJobgroupFailed: (j) => postEvent('jobgroup.failed', j),
};
