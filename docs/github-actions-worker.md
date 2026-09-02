# GitHub Actions mailbox worker

The scheduled worker is defined in [`.github/workflows/gmail-report-pipeline.yml`](../.github/workflows/gmail-report-pipeline.yml).
It runs at minutes **7, 22, 37 and 52** of every hour (UTC), or manually from
**GitHub → Actions → Gmail CSV report pipeline → Run workflow**.

Each run claims at most one durable Neon job, or performs one inbox check and exits.
It is deliberately not an always-running runner. Scheduled runs can be delayed, so this is not real-time email processing.

## Required GitHub repository secrets

```text
DATABASE_URL
BLOB_READ_WRITE_TOKEN
BROWSERLESS_API_KEY
BROWSERLESS_WS_ENDPOINT
GMAIL_USERNAME
GMAIL_PASSWORD
GMAIL_ALLOWED_SENDERS
```

`GMAIL_ALLOWED_SENDERS` is a comma-separated list of addresses authorised to submit
property CSVs and receive reports. An empty value makes the worker fail closed.
Never commit secrets, add them to workflow YAML, logs, artifacts, or `NEXT_PUBLIC_*` variables.

## Activation

1. Add the listed repository secrets.
2. Complete Browserless Gmail sign-in manually with `pnpm gmail:auth:remote`; the session is saved in Neon.
3. Run the workflow manually once, then send a small CSV from an approved sender.
4. Verify the source CSV and reports in private Blob, job state in Neon, and exactly one Gmail reply.

Transient Cotality/Browserless/Gmail errors are retried through Neon. Ambiguous addresses
are parked for review. A Google challenge marks the job `needs_reauthentication` rather
than repeatedly attempting a password login.
