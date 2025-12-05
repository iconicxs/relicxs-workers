const fs = require("fs");
const path = require("path");
const { sanitizeString } = require("@security/sanitize");
const { buildSystemPrompt } = require("../archivist.prompt");

/**
 * Build a JSONL batch file for OpenAI Batch API — renamed to "jobgroup"
 * Each line is a single chat.completions request.
 * Uses image URLs (NOT base64) because JSONL cannot exceed size limits.
 */

async function buildJobgroupJsonlFile({ jobs, workDir }) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    throw new Error("buildJobgroupJsonlFile: jobs must be non-empty array");
  }

  const jsonlPath = path.join(workDir, "jobgroup-input.jsonl");
  const writeStream = fs.createWriteStream(jsonlPath, { flags: "w" });

  const cachedPrompt = buildSystemPrompt();
  const { defaultModel } = require('../../../core/config').openai;
  const REQUEST_MODEL = defaultModel;

  let count = 0;

  for (const job of jobs) {
    const {
      tenant_id,
      asset_id,
      jobgroup_id,
      image_url
    } = job;

    if (!tenant_id || !asset_id || !image_url) {
      console.warn("Skipping invalid jobgroup item:", job);
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
      prompt_cache_retention: "24h" // required for max caching
    };

    const line = JSON.stringify({
      custom_id: customId,
      method: "POST",
      url: "/v1/chat/completions",
      body
    });

    writeStream.write(line + "\n");
  }

  // Ensure all data is flushed to disk before proceeding
  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
    writeStream.end();
  });

  return {
    jsonlPath,
    requestsCount: count,
    previewLines: count > 0
      ? fs.readFileSync(jsonlPath, "utf8").split("\n").slice(0, 3)
      : []
  };
}

module.exports = {
  buildJobgroupJsonlFile
};