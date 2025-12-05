# Relicxs Workers — Architecture Overview

This document explains how the workers system is structured and how it connects to the main Relicxs SaaS app.

---

## 1. High-Level Pipelines

There are two main pipelines:

1. **MACHINIST** – technical pipeline  
   - Input: original image file in B2 landing bucket  
   - Output: derivatives (preservation, viewing, AI, thumbnails, metadata) in B2 standard + archival ZIP in Glacier  
   - DB: writes rows into `asset` and `asset_versions`

2. **ARCHIVIST** – AI description pipeline  
   - Input: `ai/ai_version.jpg` (or fallback `viewing/viewing.jpg`) from B2 standard  
   - Output: rich AI-generated description JSON  
   - DB: upserts into `ai_description`

Both pipelines are triggered via Redis queues and use Supabase RPCs + tables as the system of record.

---

## 2. Queues & Workers

### Redis Queues

Queues are namespaced per worker to avoid cross-consumption:

- Machinist
  - `jobs:machinist:instant`   → immediate processing
  - `jobs:machinist:standard`  → normal processing (lower priority)
  - `jobs:machinist:batch`     → (reserved) batch grouping
- Archivist
  - `jobs:archivist:instant`   → immediate processing
  - `jobs:archivist:standard`  → normal processing
  - `jobs:archivist:jobgroup`  → OpenAI Batch mode

## Job Queue Contract (Source of Truth)

Use namespaced keys when enqueuing from the SaaS:

```
await redis.lPush('jobs:archivist:instant', JSON.stringify(job))
```

Legacy `jobs:instant|standard|jobgroup` are deprecated.

### Migration from legacy queues

If upgrading from shared queues, run the migration once:

```
npm run migrate:queues
```

This relocates items from legacy keys to namespaced keys using simple heuristics.
- DLQ:
  - `dlq:machinist`, `dlq:archivist`

Each job is a JSON object with (minimum) fields:

```jsonc
{
  "job_type": "machinist" | "archivist",
  "tenant_id": "uuid",
  "asset_id": "uuid",
  "batch_id": "uuid",
  "file_purpose": "preservation" | "viewing" | "production" | "restoration",   // machinist
  "processing_type": "instant" | "standard" | "batch"                          // archivist
}
```

The workers validate UUIDs, purpose, and processing_type before doing anything.

3. Storage Layout (FINAL)
Input (Landing)

Original uploads come from the SaaS app into the B2 landing bucket:

landing/tenant-{tenantId}/batch-{batchId}/asset-{assetId}/original.{ext}

B2 Standard (Processed)

All derivatives are written to the standard processed bucket:

standard/tenant-{tenantId}/asset-{assetId}/
  preservation/original.{ext}   // only for preservation jobs
  viewing/original.{ext}        // for viewing, production, restoration
  production/original.{ext}     // production jobs
  restoration/original.{ext}    // restoration jobs

  viewing/viewing.jpg
  ai/ai_version.jpg
  thumbnails/small.jpg
  thumbnails/medium.jpg
  thumbnails/large.jpg
  metadata/metadata.json

Glacier (Archive)

Only preservation jobs get a Glacier archive ZIP:

glacier/tenant-{tenantId}/asset-{assetId}.zip

4. DB Schema Touchpoints

Workers primarily interact with:

asset

a s s e t _ v e r s i o n s

batch

a i _ d e s c r i p t i o n

a s s e t

One row per logical asset

Tracks: tenant_id, batch_id, purpose, status, error_message, timestamps

a s s e t _ v e r s i o n s

One row per generated version

Key fields:

tenant_id, batch_id, asset_id

purpose: preservation | viewing | production | ai | thumbnail | restoration

variant: original | small | medium | large

storage_path: path in B2 / Glacier

status: pending | processing | complete | failed

error_message: set on failures

a i _ d e s c r i p t i o n

One row per asset, per tenant

Contains:

title, alternative_title, description, abstract, subject

 tags, keywords

 creators, contributors, events

 spatial_coverage, temporal_coverage, themes

 objects_identified, expressions_identified, models_identified

 creation_date, creation_location

Workers upsert on (tenant_id, asset_id).

b a t c h

One row per upload batch

Tracks:

status: not_started | in_progress | complete | cancelled

files_uploaded, files_received

Used by workers to update progress and final status.

5. Runtime Safety & Resilience (Summary)

Sanitization:

All UUIDs validated (RFC 4122, case-insensitive)

Filenames/extensions whitelisted (jpg, jpeg, png, tiff)

Paths built with path.posix.join to avoid traversal

Limits (see src/safety/runtime-limits.js):

Max input file size (e.g., 120MB)

Sharp max pixels + timeout

EXIFTool timeout

OpenAI max tokens + JSON size

Min free memory per job

Resilience:

withRetry wrapper for storage, EXIF, Sharp, OpenAI

Dead-letter queues for failed jobs

Stuck-job detection & batch status updates

Health server exposing /health on HEALTH_PORT (default 8081)

6. How the SaaS App Should Think About Workers

From the perspective of the Next.js SaaS:

Create a batch → insert into batch

Create assets → insert into asset (one row per file)

Upload files → to B2 landing via your upload flow

Enqueue machinist job → push to Redis queue:machinist

Wait for status:

asset.status changes, asset_versions fill in

Optionally, enqueue jobs into one of: jobs:instant | jobs:standard | jobs:jobgroup

Read ai_description once done

The SaaS app never needs to know internal worker details; it just:

inserts DB rows

uploads to the right storage path

pushing a job into Redis

reads DB + storage paths afterwards.

---

## 📘 Wave 2E-B — Update workers README

**File:** `README.md` in `relicxs-workers` (replace or extend your existing one).

Here’s a minimal but useful version you can paste and then tweak:

```md
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
B2_LANDING_BROWSER_BUCKET_ID=
B2_PROCESSED_STANDARD_BUCKET_ID=
B2_PROCESSED_ARCHIVE_BUCKET_ID=
B2_FILES_BUCKET_ID=

# AWS (Glacier / S3)
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=
AWS_GLACIER_BUCKET=

# OpenAI
OPENAI_API_KEY=

# Health
HEALTH_PORT=8081

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

We ship a PM2 ecosystem file:

ecosystem.config.js

Main processes:

machinist – Machinist worker

archivist – Archivist worker

health-server – HTTP health endpoint

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

6. More Detail

For a deeper architecture explanation, see:

docs/WORKERS-OVERVIEW.md


---

## 🧩 Wave 2E-C — (Optional but useful) Small client helper for your Next.js app

This isn’t for `relicxs-workers`, but for your **Next.js SaaS repo**.  
You don’t have to do it now, but here’s a nice clean adapter you can drop in.

**File (SaaS repo):** `lib/workers/queues.ts`

```ts
// lib/workers/queues.ts
import { createClient } from 'redis';

const redisUrl = process.env.REDIS_URL as string;
if (!redisUrl) {
  throw new Error('REDIS_URL is required for workers queue client');
}

const redis = createClient({ url: redisUrl });
redis.on('error', (err) => {
  console.error('[workers-redis] error', err);
});

let connected: Promise<void> | null = null;
async function ensureConnected() {
  if (!connected) {
    connected = redis.connect();
  }
  return connected;
}

export type FilePurpose = 'preservation' | 'viewing' | 'production' | 'restoration';
export type ProcessingType = 'instant' | 'standard' | 'batch';

export interface MachinistJob {
  job_type: 'machinist';
  tenant_id: string;
  asset_id: string;
  batch_id: string | null;
  file_purpose: FilePurpose;
}

export interface ArchivistJob {
  job_type: 'archivist';
  tenant_id: string;
  asset_id: string;
  batch_id: string | null;
  processing_type: ProcessingType;
}

export async function enqueueMachinistJob(job: MachinistJob) {
  await ensureConnected();
  await redis.lPush('queue:machinist', JSON.stringify(job));
}

export async function enqueueArchivistJob(job: ArchivistJob) {
  await ensureConnected();
  await redis.lPush('queue:archivist', JSON.stringify(job));
}

Then in your Next.js API route or server action, you can do:

import { enqueueMachinistJob } from '@/lib/workers/queues';

await enqueueMachinistJob({
  job_type: 'machinist',
  tenant_id,
  asset_id,
  batch_id,
  file_purpose: 'preservation',
});

That gives you a clean, typed bridge from SaaS → workers without touching worker internals.