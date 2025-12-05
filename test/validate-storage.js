const fs = require('fs');
const os = require('os');
const path = require('path');
const fse = require('fs-extra');
const { downloadFile } = require('../src/core/storage');
const config = require('../src/core/config');

async function mustDownload(key) {
  const tmp = path.join(os.tmpdir(), `check-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fse.ensureDirSync(tmp);
  const local = path.join(tmp, path.basename(key));
  await downloadFile(config.b2.processedStandardBucketId, key, local);
  const stat = fs.statSync(local);
  if (!stat.size) throw new Error(`Downloaded file empty for key ${key}`);
  return { local, stat };
}

async function assertPreservationPaths(tenantId, assetId, ext) {
  const base = `standard/tenant-${tenantId}/asset-${assetId}`;
  const keys = [
    `${base}/preservation/original.${ext}`,
    `${base}/viewing/viewing.jpg`,
    `${base}/ai/ai_version.jpg`,
    `${base}/thumbnails/small.jpg`,
    `${base}/thumbnails/medium.jpg`,
    `${base}/thumbnails/large.jpg`,
    `${base}/metadata/metadata.json`,
  ];
  for (const k of keys) await mustDownload(k);
}

async function assertViewingPaths(tenantId, assetId, ext) {
  const base = `standard/tenant-${tenantId}/asset-${assetId}`;
  const keys = [
    `${base}/viewing/original.${ext}`,
    `${base}/viewing/viewing.jpg`,
    `${base}/ai/ai_version.jpg`,
    `${base}/thumbnails/small.jpg`,
    `${base}/thumbnails/medium.jpg`,
    `${base}/thumbnails/large.jpg`,
    `${base}/metadata/metadata.json`,
  ];
  for (const k of keys) await mustDownload(k);
}

async function assertProductionPaths(tenantId, assetId, ext) {
  const base = `standard/tenant-${tenantId}/asset-${assetId}`;
  const keys = [
    `${base}/production/original.${ext}`,
    `${base}/viewing/viewing.jpg`,
    `${base}/thumbnails/small.jpg`,
    `${base}/thumbnails/medium.jpg`,
    `${base}/thumbnails/large.jpg`,
    `${base}/metadata/metadata.json`,
  ];
  for (const k of keys) await mustDownload(k);
}

async function assertRestorationPaths(tenantId, assetId, ext) {
  const base = `standard/tenant-${tenantId}/asset-${assetId}`;
  const keys = [
    `${base}/restoration/original.${ext}`,
    `${base}/viewing/viewing.jpg`,
    `${base}/thumbnails/small.jpg`,
    `${base}/thumbnails/medium.jpg`,
    `${base}/thumbnails/large.jpg`,
    `${base}/metadata/metadata.json`,
  ];
  for (const k of keys) await mustDownload(k);
}

module.exports = { mustDownload, assertPreservationPaths, assertViewingPaths, assertProductionPaths, assertRestorationPaths };
