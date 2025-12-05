process.env.NODE_ENV = 'test';
process.env.OPENAI_MOCK_DIR = __dirname;

const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
require('../src/module-aliases');
const { createClient } = require("@supabase/supabase-js");
const config = require("@config");

/**
 * run-jobgroup-test.js
 * E2E simulation:
 * - Inserts fake assets (5)
 * - Runs jobgroup creation via CLI
 * - Fakes OpenAI batch completion (writes mock output file)
 * - Invokes poller
 * - Validates DB + jobgroup_results + ai_description
 */

async function main() {
  console.log("== run-jobgroup-test ==");

  const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

  const tenantId = process.env.TEST_TENANT_ID || '00000000-0000-4000-8000-000000000000';
  const batchId = process.env.TEST_BATCH_ID || '00000000-0000-4000-8000-000000000001';

  console.log("→ Inserting fake assets...");
  const assets = [];
  for (let i = 0; i < 5; i++) {
    const { data, error } = await supabase
      .from("asset")
      .insert({
        tenant_id: tenantId,
        batch_id: batchId,
        original_filename: `fake-${i}.jpg`
      })
      .select("*")
      .single();

    if (error) throw error;
    assets.push(data);
  }

  console.log("→ Running jobgroup creation via CLI...");
  execSync(
    `node scripts/jobgroup-cli.js create-jobgroup ${tenantId} ${batchId} jobgroup`,
    { stdio: "inherit" }
  );

  console.log("→ Fetching jobgroup from DB...");
  const { data: jobgroups } = await supabase
    .from("jobgroups")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(1);

  if (!jobgroups || jobgroups.length === 0) throw new Error("No jobgroup created");
  const jobgroup = jobgroups[0];

  console.log("→ Faking OpenAI batch completion...");
  const fakeOutput = assets
    .map((a) =>
      JSON.stringify({
        custom_id: `asset-${a.id}`,
        response: {
          body: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: "Fake title",
                    description: "Fake description",
                    tags: ["fashion"],
                    keywords: ["test"]
                  })
                }
              }
            ],
            usage: { prompt_tokens: 1000, completion_tokens: 10 }
          }
        }
      })
    )
    .join("\n");

  const fakeOutputPath = path.join(__dirname, "fake-output.jsonl");
  fs.writeFileSync(fakeOutputPath, fakeOutput);

  console.log("→ Marking jobgroup for poller (mock mode: local output file)");
  await supabase
    .from("jobgroups")
    .update({
      output_file_id: "fake-output",
      status: "in_progress"
    })
    .eq("id", jobgroup.id);

  console.log("→ Running jobgroup poller once (mock mode)");
  const poller = require("../src/workers/archivist/archivist.jobgroup.poller");
  await poller.pollOnce(console);

  console.log("→ Validating jobgroup_results (best-effort)");
  const { data: results } = await supabase
    .from("jobgroup_results")
    .select("*")
    .eq("jobgroup_id", jobgroup.id);

  if (results && results.length) {
    console.log(`jobgroup_results rows: ${results.length}`);
  } else {
    throw new Error('Expected jobgroup_results after mock processing');
  }

  console.log("→ Validating ai_description (best-effort)");
  const { data: desc } = await supabase
    .from("ai_description")
    .select("*")
    .eq("batch_id", batchId);

  console.log(`ai_description rows for batch: ${desc ? desc.length : 0}`);
  if (!desc || !desc.length) throw new Error('Expected ai_description rows after mock processing');

  console.log("PASS: run-jobgroup-test");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
