# AWS Lambda mailbox worker

`lambda/mailbox-worker.ts` runs one invocation of the same durable worker used
by `pnpm worker:scheduled`. It does not use Playwright or Browserless: mailbox
access is through the encrypted OAuth refresh token stored in Neon.

## Runtime flow

1. Claim one queued Neon job with its lease.
2. If there is no job, scan the configured Gmail or Outlook mailbox once.
3. Store valid CSVs in Vercel Blob and create idempotent Neon jobs.
4. Generate at most one claimed job's reports, store PDFs in Blob, and send
   one reply per report.

The Lambda must receive the same runtime environment values currently passed to
the GitHub Actions worker: `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`,
`PARCEL_ATLAS_BASE_URL`, Cotality credentials, `GMAIL_CLIENT_ID`,
`GMAIL_CLIENT_SECRET`, `GMAIL_REDIRECT_URI`, `GMAIL_TOKEN_ENCRYPTION_KEY`,
`GMAIL_ALLOW_ANY_SENDER`, and—when Outlook is selected—`OUTLOOK_CLIENT_ID`,
`OUTLOOK_CLIENT_SECRET`, `OUTLOOK_REDIRECT_URI`, `OUTLOOK_TENANT_ID`, and
`MAILBOX_PROVIDER=outlook`.

Store those values in AWS Secrets Manager; do not place secret values in
`template.yaml` or commit an AWS credentials file. The included SAM template
creates only the function, its five-minute EventBridge schedule, and permission
to read the named secret. Configure the secret values as Lambda environment
variables during deployment (or extend the deployment stack with a controlled
secret-to-environment mapping).

Use a 15-minute Lambda timeout. The worker's Neon lease/idempotency rules make
scheduled retries and overlapping invocations safe.
