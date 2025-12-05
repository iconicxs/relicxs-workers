const path = require('path');
const os = require('os');
const crypto = require('crypto');
const sharp = require('sharp');
const fse = require('fs-extra');

function randId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

function makeIds() {
  return {
    tenant_id: randId('tenant'),
    batch_id: randId('batch'),
    asset_id: randId('asset'),
  };
}

async function createFixtureImage(width = 1200, height = 800) {
  const dir = path.join(os.tmpdir(), `fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fse.ensureDirSync(dir);
  const p = path.join(dir, 'original.jpg');
  await sharp({ create: { width, height, channels: 3, background: { r: 220, g: 220, b: 220 } } })
    .jpeg({ quality: 90 })
    .toFile(p);
  return p;
}

function buildMachinistJob({ ids, purpose = 'viewing', ext = 'jpg' }) {
  return {
    tenant_id: ids.tenant_id,
    batch_id: ids.batch_id,
    asset_id: ids.asset_id,
    job_type: 'image_processing',
    file_purpose: purpose,
    original_extension: ext,
  };
}

function buildArchivistJob({ ids }) {
  return {
    tenant_id: ids.tenant_id,
    batch_id: ids.batch_id,
    asset_id: ids.asset_id,
    ai_description_id: randId('ai'),
    processing_type: 'individual',
    job_type: 'ai_analysis',
  };
}

module.exports = { makeIds, createFixtureImage, buildMachinistJob, buildArchivistJob };
