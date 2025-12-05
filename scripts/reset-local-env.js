#!/usr/bin/env node

// Local env reset helper for Relicxs workers
// - Flushes Redis (current DB)  ➜ for local/dev ONLY
// - Cleans common temp + mock folders
// - Prints SQL you can run manually to wipe test tables

// Preload module aliases so @core/* etc. work if you extend this later
try {
  // Optional: only exists in this repo
  require("../src/module-aliases");
} catch (e) {
  // Ignore if not present
}

const path = require("path");
const fs = require("fs");
const fse = require("fs-extra");
const { createClient } = require("redis");

let config;
try {
  // Optional: if @core/config exists, we use it for REDIS_URL + mock dir
  config = require("@core/config");
} catch (e) {
  config = {};
}

const REDIS_URL =
  process.env.REDIS_URL ||
  (config && config.redis && config.redis.url) ||
  "redis://localhost:6379/0";

const OPENAI_MOCK_DIR =
  process.env.OPENAI_MOCK_DIR ||
  (config && config.openaiMockDirectory) ||
  path.join(process.cwd(), "test", "openai-mock");

const TEMP_DIRS = [
  path.join(process.cwd(), ".tmp"),
  path.join(process.cwd(), "tmp"),
  path.join(process.cwd(), "test", "output"),
];

async function flushRedis() {
  console.log("🔄 [RESET] Connecting to Redis:", REDIS_URL);
  const client = createClient({ url: REDIS_URL });

  client.on("error", (err) => {
    console.error("❌ [RESET] Redis client error:", err.message);
  });

  await client.connect();
  console.log("✅ [RESET] Connected to Redis");

  // Flush ONLY the current DB (not the whole Redis instance)
  await client.flushDb();
  console.log("🧹 [RESET] Redis DB flushed (local/dev only)");

  await client.quit();
}

async function cleanDirSafe(dir) {
  try {
    if (fs.existsSync(dir)) {
      await fse.remove(dir);
      console.log(`🧹 [RESET] Removed directory: ${dir}`);
    } else {
      console.log(`ℹ️ [RESET] Directory not found (skipped): ${dir}`);
    }
  } catch (err) {
    console.error(`❌ [RESET] Failed to clean ${dir}:`, err.message);
  }
}

async function cleanTempAndMocks() {
  console.log("🔄 [RESET] Cleaning temp + mock directories...");
  for (const dir of TEMP_DIRS) {
    await cleanDirSafe(dir);
  }

  // OPENAI mock directory
  await cleanDirSafe(OPENAI_MOCK_DIR);
}

function printSqlHelp() {
  console.log("\n📜 [RESET] Suggested SQL for wiping local test data (run manually in Supabase):\n");
  console.log("-- ⚠️ ONLY run this against a LOCAL/DEV project, NEVER production.");
  console.log("BEGIN;");
  console.log("  DELETE FROM jobgroup_results;");
  console.log("  DELETE FROM jobgroups;");
  console.log("  DELETE FROM ai_description;");
  console.log("  DELETE FROM asset_versions;");
  console.log("  DELETE FROM asset;");
  console.log("  DELETE FROM batch;");
  console.log("COMMIT;");
  console.log("\nYou can paste this into the Supabase SQL editor or psql for your *dev* project.\n");
}

async function main() {
  console.log("==================================================");
  console.log("🧰 Relicxs Workers — Local Env Reset (SAFE HELPER)");
  console.log("==================================================\n");

  try {
    await flushRedis();
  } catch (err) {
    console.error("❌ [RESET] Redis flush failed:", err.message);
  }

  try {
    await cleanTempAndMocks();
  } catch (err) {
    console.error("❌ [RESET] Temp/mock cleaning failed:", err.message);
  }

  printSqlHelp();

  console.log("✅ [RESET] Done. Redis + temp dirs cleaned. See SQL above for DB cleanup.\n");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("❌ [RESET] Unexpected error:", err);
    process.exit(1);
  });
}
