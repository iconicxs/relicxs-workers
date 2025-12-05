# relicxs-workers Test Suite

CommonJS-only integration tests for Machinist and Archivist pipelines.

Prerequisites:
- Redis reachable via configured env
- Supabase env configured with service key
- OpenAI API key set (for Archivist)
- Backblaze B2 storage implemented in core/storage.js
- AWS credentials and GLACIER_BUCKET env for Glacier uploads

Run examples:
- node test/run-preservation-test.js
- node test/run-viewing-test.js
- node test/run-production-test.js
- node test/run-restoration-test.js
- node test/run-archivist-test.js
- node test/test-batch-end-to-end.js

These tests will spawn worker processes and push jobs into queues, then validate storage and DB.

## B2 Concurrency Limiting

Backblaze B2 uploads/downloads are limited via a global concurrency pool.

- Configured by `B2_CONCURRENCY_LIMIT` (default: 5)
- Implemented in `src/core/b2-concurrency.js`
- Applied automatically inside `src/core/storage.js` — no call-site changes required.

Adjust `B2_CONCURRENCY_LIMIT` to tune parallelism without code changes.

### Jobgroup polling

The Archivist worker now supports "jobgroup" mode via the OpenAI Batch API.

- Jobgroup rows are created on submission.
- A poller runs every hour to update status (configurable via `JOBGROUP_POLL_INTERVAL_MS`).
- When completed, results are downloaded and written into:
	- `jobgroup_results`
	- `ai_description`

### Jobgroup Tests

- `run-jobgroup-test.js` — structural test
- `run-jobgroup-success-test.js` — full end-to-end mock jobgroup test
	- Creates fake assets
	- Generates jobgroup
	- Writes mock OpenAI JSONL
	- Poller processes results
	- Verifies ai_description + jobgroup_results