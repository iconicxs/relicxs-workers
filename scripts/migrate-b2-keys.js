#!/usr/bin/env node
/*
  migrate-b2-keys.js
  - Dry-run prints mapping old -> new
  - --commit will copy files from old keys (prefixes 'standard/' or 'files/') to new tenant-first keys
  - Does not delete old files
*/
const B2 = require('backblaze-b2');
const os = require('os');
const fs = require('fs');
const path = require('path');
const storage = require('../src/core/storage');
const config = require('../src/core/config');

const argv = require('minimist')(process.argv.slice(2));
const doCommit = !!argv.commit;
const dryRun = !doCommit;

function getB2Client() {
  const b2 = new B2({ applicationKeyId: config.b2.applicationKeyId, applicationKey: config.b2.applicationKey });
  return b2;
}

async function listAll(bucketId) {
  const b2 = getB2Client();
  await b2.authorize();
  let start = null;
  const out = [];
  do {
    const res = await b2.listFileNames({ bucketId, startFileName: start, maxFileCount: 1000 });
    if (!res || !res.data || !res.data.files) break;
    for (const f of res.data.files) out.push(f);
    start = res.data.nextFileName || null;
  } while (start);
  return out;
}

function computeNewKey(oldKey) {
  // Remove leading known legacy prefixes
  let k = oldKey;
  if (k.startsWith('standard/')) k = k.replace(/^standard\//, '');
  if (k.startsWith('files/')) k = k.replace(/^files\//, '');
  // If already tenant-first, return as-is
  if (k.startsWith('tenant-')) return k;
  return k; // fallback
}

async function copyObject(bucketId, oldKey, newKey) {
  // download to tmp and upload
  const tmp = path.join(os.tmpdir(), `migrate-${Date.now()}-${Math.random().toString(36).slice(2)}-${path.basename(oldKey)}`);
  try {
    await storage.downloadFile(bucketId, oldKey, tmp);
    await storage.uploadFile(bucketId, newKey, tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch(_) {}
  }
}

(async function main(){
  console.log('Starting migration (dryRun=%s). Buckets:', dryRun);
  console.log(' processedStandard:', config.b2.processedStandardBucketId);
  console.log(' processedArchive:', config.b2.processedArchiveBucketId);
  console.log(' filesBucket:', config.b2.filesBucketId);

  const buckets = [
    { id: config.b2.processedStandardBucketId, name: 'processedStandard' },
    { id: config.b2.processedArchiveBucketId, name: 'processedArchive' },
    { id: config.b2.filesBucketId, name: 'files' },
  ].filter(b => !!b.id);

  for (const b of buckets) {
    console.log('\nListing bucket', b.name, b.id);
    const files = await listAll(b.id);
    for (const f of files) {
      const oldKey = f.fileName;
      if (!oldKey.startsWith('standard/') && !oldKey.startsWith('files/')) continue;
      const newKey = computeNewKey(oldKey);
      if (oldKey === newKey) continue;
      console.log(`${b.name}: ${oldKey} => ${newKey}`);
      if (doCommit) {
        try {
          await copyObject(b.id, oldKey, newKey);
          console.log('  copied');
        } catch (err) {
          console.error('  failed to copy', err && err.message);
        }
      }
    }
  }
  console.log('\nDone');
})();
