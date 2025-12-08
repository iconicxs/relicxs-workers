# Relicxs Workers

Background workers for Relicxs:

- **MACHINIST** – technical image pipeline (derivatives + storage)
- **ARCHIVIST** – AI description pipeline (semantic metadata)

These workers are designed to be run alongside the main Relicxs SaaS (Next.js) app.

---

## 1. Requirements

- Node.js 20+
- Redis (same instance as the SaaS app uses for queues)
- Supabase project (Postgres + RPCs configured)
- Backblaze B2
- AWS S3 / Glacier

### System dependencies

Some steps shell out to system binaries that are not installed via npm:

- `exiftool` (for EXIF metadata extraction)

Install examples:

- macOS (Homebrew): `brew install exiftool`
- Ubuntu/Debian: `sudo apt-get update && sudo apt-get install -y libimage-exiftool-perl`

If `exiftool` is not present, the pipeline will skip EXIF extraction gracefully and continue.

---

## 2. Environment Variables

See `src/core/config.js` and `src/startup/check-env.js` for the full list.

Key variables:

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SERVICE_KEY=

# Redis
REDIS_URL=

# B2
B2_APPLICATION_KEY_ID=
B2_APPLICATION_KEY=
B2_LANDING_BUCKET_ID=
B2_PROCESSED_STANDARD_BUCKET_ID=
B2_PROCESSED_ARCHIVE_BUCKET_ID=
B2_FILES_BUCKET_ID=

# AWS (Glacier / S3)
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=
AWS_ARCHIVE_BUCKET=

# OpenAI
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o

# Health
HEALTH_PORT=8081

# Jobgroup Polling (optional overrides)
# Default 5 minutes for both; active/idle can be tuned separately
JOBGROUP_POLL_ACTIVE_INTERVAL_MS=300000   # 5 minutes
JOBGROUP_POLL_IDLE_INTERVAL_MS=300000     # 5 minutes

# Audit Logs (optional)
# Directory for jobgroup audit logs; defaults to OS temp dir
JOBGROUP_AUDIT_LOG_DIR=/var/log/relicxs/jobgroups

# Alerts (optional)
# Webhook to receive DLQ events as JSON POSTs
DLQ_WEBHOOK_URL=

## Job Queue Contract (Source of Truth)

Queues are namespaced per worker to prevent cross-consumption:

- Machinist:
	- `jobs:machinist:instant`
	- `jobs:machinist:standard`
- Archivist:
	- `jobs:archivist:instant`
	- `jobs:archivist:standard`
	- `jobs:archivist:jobgroup`

Note: Machinist batch is not supported.

Example enqueue (Archivist instant):

```
await redis.lPush('jobs:archivist:instant', JSON.stringify(job))
```

3. Scripts

From the relicxs-workers root:

# Basic start (single-process)
npm start

# Run all tests (integration + safety)
npm test

# Just run safety test
node test/safety-test.js

# Individual integration tests
node test/run-preservation-test.js
node test/run-viewing-test.js
node test/run-production-test.js
node test/run-restoration-test.js
node test/run-archivist-test.js
node test/test-batch-end-to-end.js

4. PM2 Supervision

We ship a PM2 ecosystem file at `pm2/ecosystem.config.js`.

Main processes:

machinist – Machinist worker

archivist – Archivist worker

endpoints-server – HTTP ops/health endpoint

Useful scripts (in scripts/):

# Restart workers
./scripts/restart-workers.sh

# Tail logs
./scripts/tail-workers.sh

# Deploy updated code
./scripts/deploy.sh

# Roll back last deployment
./scripts/rollback.sh

5. Health Checks

Health server runs on HEALTH_PORT (default 8081):

curl http://localhost:8081/health


It reports:

Redis connectivity

Queue depths

Basic process stats (uptime, memory, CPU load)

6. DRY RUN MODE

Set `DRY_RUN=true` to disable all external writes:

- No Supabase writes
- No B2 uploads/downloads
- No Glacier uploads
- No OpenAI calls
- Jobgroups instantly complete
- Poller disabled

Useful for staging, testing, and debugging.

7. More Detail

For a deeper architecture explanation, see:

docs/WORKERS-OVERVIEW.md

