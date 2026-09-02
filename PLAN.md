# Production delivery plan — Parcel Atlas Gmail report pipeline

## Goal

Run the full workflow reliably in production:

1. An approved sender emails a CSV attachment to the report mailbox.
2. A remote Browserless browser checks that mailbox using the dedicated bot account.
3. The worker downloads the CSV, matches each address with Cotality, and generates one HTML report per exact match.
4. Reports and progress checkpoints are retained durably.
5. The worker replies to the original sender with every completed report attached.
6. A retry resumes from the last safe checkpoint, without duplicate emails or regenerated completed reports.

## Production architecture

| Component | Responsibility | Runtime |
| --- | --- | --- |
| Vercel / Next.js | Website, Cotality API routes, job status and user interface | `australian-property.vercel.app` |
| Neon Postgres | Durable job, property-level, and reply checkpoints | Neon hosted Postgres |
| Vercel Blob (private) | Original CSV attachments and generated HTML reports | Private `parcel-atlas-reports` store |
| GitHub Actions | Scheduled finite mailbox/job worker; manual dispatch for immediate processing | Every 15 minutes |
| Browserless | Remote Playwright/Chrome session for the Gmail mailbox | Browserless WebSocket endpoint |
| Gmail | Dedicated bot mailbox, CSV intake and report replies | Bot account only |

## Completed

- [x] Built the property search, Cotality enrichment and comparable-report frontend.
- [x] Added CSV processing and standalone HTML report generation.
- [x] Added report quality rules: exact-address handling, match scoring threshold, rent-required filtering and rent outlier exclusion.
- [x] Added the local Playwright + Browserless Gmail pipeline:
  - finds CSV attachments;
  - downloads them to `data/incoming_csv`;
  - runs the Cotality batch command;
  - attaches generated HTML reports;
  - sends the reply through Gmail.
- [x] Added local file-based checkpoints and per-property retry behaviour.
- [x] Verified local end-to-end email delivery and report attachment flow.
- [x] Fixed Vercel's pnpm build failure by pinning pnpm `10.32.1`.
- [x] Deployed the current Next.js application to Vercel and verified production address matching.
- [x] Created the private Vercel Blob store `parcel-atlas-reports`.
- [x] Linked the Blob store to the Vercel project for Production and Preview, creating `BLOB_READ_WRITE_TOKEN` there.
- [x] Added `DATABASE_URL` to Vercel Production and Preview secrets.
- [x] Confirmed access to the Neon database and Render workspace.

## Remaining implementation

### 1. Durable database checkpoint layer

- [x] Create Neon tables for jobs, CSV attachments, individual property reports and reply attempts.
      Also `job_events` (transition journal), `worker_heartbeats`, `gmail_sessions`. See `frontend/lib/db.ts`.
- [x] Add idempotency keys based on source email + attachment hash.
      `buildIdempotencyKey` uses Gmail thread/message identity + SHA-256 CSV content hash.
- [x] Lease one job at a time so two workers cannot process the same email.
      `claimNextJob` uses `BEGIN … FOR UPDATE SKIP LOCKED … COMMIT` via the pooled driver;
      the HTTP driver cannot express interactive transactions. Expired leases are reclaimable.
- [x] Persist every state transition: queued, claimed, running, downloaded, matched,
      report_generated, replying, completed, retryable_failed, needs_review, needs_reauthentication, failed.
- [x] Provide a retry policy with bounded backoff for Cotality, Browserless and Gmail failures.
      `frontend/lib/retry-policy.ts`: 5 attempts max, capped exponential backoff with jitter;
      permanent validation errors never consume retry budget.

### 2. Durable Blob storage layer

- [x] Upload each downloaded CSV to the private Blob store before processing.
- [x] Upload each generated report immediately after it is written.
- [x] Store Blob pathnames in Neon rather than machine-local paths.
      `raw_content` was dropped from `csv_attachments`; Blob is the store of record.
- [x] On retry, download only the reports required for the final email reply.
      `deliverReply` fetches only rows with status `generated`.
- [x] Add retention/cleanup rules for completed jobs and reports.
      `pnpm blob:cleanup` (dry run by default, `--commit` to delete); artifacts of
      non-terminal jobs are protected from deletion.

### 3. Scheduled GitHub Actions worker

- [x] Add a production worker entry point that processes one leased job or one mailbox check, then exits.
- [x] Move the current Browserless Gmail crawl and reply logic into that worker process.
      `frontend/lib/gmail-worker.ts`; session state lives in Neon, not `.local`.
- [x] Ensure the worker uses a single concurrency slot to protect Cotality rate limits and the Gmail mailbox.
      One `claimNextJob` per cycle; `numInstances: 1`.
- [x] Add structured logs and a health/status heartbeat in Neon.
      JSON logs with secret redaction; `worker_heartbeats` + `/api/worker/health`.
- [x] Add a scheduled GitHub Actions workflow plus a manual-dispatch option.
- [ ] Add the required GitHub repository secrets, especially `GMAIL_ALLOWED_SENDERS`.
- [ ] Authenticate the dedicated Gmail mailbox in Browserless and save the session in Neon.

### 4. Vercel job UI and API

- [x] Add an authenticated Vercel API route to enqueue/report a job; it must not run Playwright itself.
      `POST /api/gmail/jobs`. The two routes that ran Playwright/child processes in a
      Vercel function were deleted.
- [x] Add a status endpoint that reads Neon job state.
      `GET /api/gmail/jobs`, `GET /api/gmail/jobs/[id]`, `GET /api/worker/health`.
- [x] Update the Auto-pilot UI to display durable job status and completed report links.
      Reports stream from the private store via `/api/gmail/jobs/[id]/reports/[filename]`.
- [x] Make production Auto-pilot enqueue work and show a clear queued/running/completed/failed result.

### 5. Production secrets and safety

- [x] Keep `GMAIL_PASSWORD`, Browserless and Cotality credentials server-side only; never
      exposed through Next.js or client code. No `NEXT_PUBLIC_` credential exists.
      The UI authenticates with an httpOnly cookie, never the raw token.
- [x] Require `GMAIL_ALLOWED_SENDERS` and reject all other senders.
      The worker refuses to process any mail when the allow-list is empty (verified).
- [x] Validate CSV size, MIME type, address-column shape and attachment limits.
      `frontend/lib/csv-intake.ts`: 1 MB, 10 addresses, MIME allow-list, address column required.
- [x] Keep Google 2FA enabled; if Google presents a challenge, mark the job as
      `needs_reauthentication` instead of retrying credentials indefinitely.
      One login attempt only; challenge detection aborts without retrying.
- [ ] Set the production `GMAIL_REDIRECT_URI` if OAuth features remain enabled.
- [ ] Rotate temporary credentials after the production cutover.

## Deployment and verification checklist

- [x] Run database migration against Neon. Idempotent; verified by re-running.
- [x] Build and type-check the frontend. `tsc --noEmit` and `eslint` clean; `next build` succeeds.
- [x] Automated test suite: 96 tests passing (`pnpm test`).
- [x] Durability verified against the real Neon database: 14/14 checks, including two
      concurrent claim attempts yielding exactly one winner.
- [x] Private Blob store verified: 8/8 checks. `access=private`, anonymous fetch returns 403.
- [x] Test an unmatched address, Cotality 429, Browserless session expiry and Gmail send failure.
      Covered in `tests/integration-flow.test.ts` with stubbed transports.
- [x] Confirm a crash mid-run resumes only the outstanding reports and sends exactly one email.
- [ ] Deploy the Vercel API/UI changes.
- [ ] Enable/dispatch the GitHub Actions worker and confirm one scheduled run completes.
- [ ] Confirm GitHub Actions secret names (without printing values).
- [ ] Send a live test CSV from an allowed email with three exact-match addresses.
- [ ] Confirm three reports in Blob, rows in Neon, and one Gmail reply with all three attached.
- [ ] Restart the worker mid-test against the live mailbox and confirm no duplicates.
- [ ] Review Render/Vercel/Neon logs and mark the production pipeline operational.

## Architecture notes

**Reports no longer require a browser.** `cotality-batch-reports.ts` drove the batch UI with
a local Chromium, which cannot work on an ephemeral worker runtime. The report builder was extracted
to `frontend/lib/report-html.ts` (isomorphic, no DOM or `node:` imports) and the worker calls
it over HTTPS through `frontend/lib/report-pipeline.ts`. Images embed as data URIs, so a
stored report renders offline as an email attachment.

**Two Neon drivers, on purpose.** `neon()` HTTP for short Vercel reads; `Pool` for the worker,
because job leasing needs a real interactive transaction.

**A "sent" reply is a database fact, not a code path.** A partial unique index on
`reply_attempts(job_id) WHERE status = 'sent'` makes a second confirmed reply impossible even
under a race. Verified by attempting one.
