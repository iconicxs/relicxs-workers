module.exports = {
  // Maximum file size allowed to process (original)
  MAX_INPUT_BYTES: 120 * 1024 * 1024, // 120MB

  // Maximum archive size allowed for preservation bundles
  // Large enough for multi-file workDirs but prevents runaway disk usage
  MAX_ARCHIVE_BYTES: 2 * 1024 * 1024 * 1024, // 2GB

  // Sharp processing safety
  SHARP_TIMEOUT_MS: 30_000, // 30 seconds max for heavy images
  SHARP_MAX_PIXELS: 20000 * 20000, // 400 million pixels
  SHARP_MAX_DIMENSION: 20000, // width/height

  // EXIFTool safety
  EXIF_TIMEOUT_MS: 10_000, // kill after 10 seconds

  // AI safety
  OPENAI_MAX_TOKENS: 4096,
  OPENAI_MAX_JSON_BYTES: 500 * 1024, // 500 KB JSON is more than enough

  // System safety
  MAX_JOB_DURATION_MS: 5 * 60 * 1000, // 5 minutes max per asset
  MIN_FREE_MEMORY_MB: 300, // auto-fail if memory below threshold
};