// Full local E2E runner using DRY_RUN (no external calls)
process.env.DRY_RUN = 'true';

const fs = require('fs');
const path = require('path');
const os = require('os');

require('../src/module-aliases');

const config = require('@config');
const { createChildLogger } = require('@core/logger');
const testLogger = createChildLogger({ suite: 'local-suite' });

const { runMachinistPipeline } = require('@machinist/machinist.pipeline');
const { runArchivistPipeline } = require('@archivist/archivist.pipeline');
const { runJobgroupArchivist } = require('@archivist/archivist.batch');
const { pollOnce } = require('@archivist/archivist.jobgroup.poller');

async function main() {
  // MODE A: always use ./test/assets
  const defaultAssets = path.join(__dirname, 'assets');
  const folder = defaultAssets;

  console.log('📂 Using local fixture folder:', folder);

  console.warn('⚠ DRY RUN ENABLED — using local images only.');

  const files = fs
    .readdirSync(folder)
    .filter((f) => /\.(jpg|jpeg|png|tif|tiff)$/i.test(f))
    .map((f) => path.join(folder, f));

  if (!files.length) {
    console.error('No images found in folder:', folder);
    console.error('Add a few small images like img1.jpg into test/assets');
    process.exit(1);
  }

  console.log(`📂 Loaded ${files.length} images`);

  // 1) Fake-create assets
  const fakeAssets = files.map((file, i) => ({
    id: `asset-${String(i).padStart(4, '0')}`,
    tenant_id: 'dry_tenant',
    batch_id: 'dry_batch',
    local_path: file,
  }));

  console.log(`✔ Prepared ${fakeAssets.length} fake assets`);

  // 2) Machinist (dry-run)
  console.log('\n🔧 Running Machinist...');
  for (const asset of fakeAssets) {
    await runMachinistPipeline(testLogger, {
      tenant_id: asset.tenant_id,
      asset_id: asset.id,
      batch_id: asset.batch_id,
      file_purpose: 'viewing',
      original_extension: path.extname(asset.local_path).slice(1) || 'jpg',
    });
  }
  console.log('✔ Machinist complete');

  // 3) Archivist (standard) — dry-run
  console.log('\n🧠 Running Archivist...');
  for (const asset of fakeAssets) {
    await runArchivistPipeline(testLogger, {
      tenant_id: asset.tenant_id,
      asset_id: asset.id,
      batch_id: asset.batch_id,
      processing_type: 'standard',
    });
  }
  console.log('✔ Archivist complete');

  // 4) Jobgroup Batch Simulation (dry-run)
  console.log('\n📦 Running Jobgroup Batch...');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobgroup-local-'));
  const jobgroup = await runJobgroupArchivist({
    logger: testLogger,
    jobs: fakeAssets.map((a) => ({
      tenant_id: a.tenant_id,
      asset_id: a.id,
      batch_id: a.batch_id,
      image_url: 'file://' + a.local_path,
    })),
    workDir,
  });

  console.log('✔ Jobgroup Created:', jobgroup);

  // 5) Poller (dry-run: exits immediately)
  console.log('\n🔄 Polling Jobgroup...');
  await pollOnce(testLogger);

  console.log('\n✨ E2E Test Finished');
  console.log(`\n🎉 EVERYTHING PASSED — DRY RUN MODE\nAll pipelines (machinist, archivist, jobgroup, poller) executed successfully.\nCheck logs above for any warnings.\n`);
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
