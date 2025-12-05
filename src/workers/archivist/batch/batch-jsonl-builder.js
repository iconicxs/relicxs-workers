const fs = require("fs");
const path = require("path");
const { sanitizeString } = require("@security/sanitize");
const { buildSystemPrompt } = require("../archivist.prompt");

/**
 * Build a JSONL batch file for the OpenAI Batch API.
 * Each line represents a single chat.completions request.
 * Uses image URLs (NOT base64) to keep the file small.
 */

async function buildBatchJsonlFile({ jobs, workDir }) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    throw new Error("buildBatchJsonlFile: jobs must be non-empty array");
  }

  const jsonlPath = path.join(workDir, "batch-input.jsonl");
  const writeStream = fs.createWriteStream(jsonlPath, { flags: "w" });

  const cachedPrompt = buildSystemPrompt(); // static system prompt
  const { defaultModel } = require('../../../core/config').openai;
  const REQUEST_MODEL = defaultModel;             // required: same model for all batch requests

  let count = 0;

  for (const job of jobs) {
    const {
      tenant_id,
      asset_id,
      batch_id,
      image_url
    } = job;

    if (!tenant_id || !asset_id || !image_url) {
      console.warn("Skipping invalid batch job:", job);
      continue;
    }

    count++;

    const customId = `asset-${asset_id}`;

    const messages = [
      {
        role: "system",
        content: cachedPrompt
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Please analyze the following image." },
          { type: "image_url", image_url: { url: image_url, detail: "high" } }
        ]
      }
    ];

    const body = {
      model: REQUEST_MODEL,
      messages,
      max_tokens: 2000,
      temperature: 0.2,
      prompt_cache_retention: "24h"
    };

    const line = JSON.stringify({
      custom_id: customId,
      method: "POST",
      url: "/v1/chat/completions",
      body
    });

    writeStream.write(line + "\n");
  }

  writeStream.end();

  return {
    jsonlPath,
    requestsCount: count,
    previewLines: count > 0 ? fs.readFileSync(jsonlPath, "utf8").split("\n").slice(0, 3) : []
  };
}

module.exports = {
  buildBatchJsonlFile
};