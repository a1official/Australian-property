# AWS Lambda deployment brief — Australian Property report pipeline

## Purpose of this document

Use this document as the implementation prompt and architecture reference for migrating the **backend only** of the Australian Property rent-review pipeline from GitHub Actions/Vercel server routes to AWS Lambda.

The Vercel frontend remains the user-facing application. The frontend manually starts a mailbox/report run. **Do not add EventBridge, cron, or any automatic schedule at this stage.**

The resulting system must:

- accept a manual run request from the existing Vercel frontend;
- scan the connected Gmail mailbox for CSV attachments;
- create one PDF rent review per exact-match property;
- send one report email per completed property;
- allow one failed property to be reviewed/retried without withholding already-completed reports;
- prevent duplicate processing and duplicate outgoing emails;
- protect Cotality from bursts, retries, and concurrent overuse.

---

## Current business workflow

1. A user connects Gmail through the Vercel frontend using OAuth.
2. A sender emails a CSV attachment to the connected mailbox.
3. The user presses **Auto-pilot: scan inbox** in the Vercel frontend.
4. The backend finds eligible CSV attachments, validates rows, and resolves each property address.
5. For each exact match, the backend fetches Cotality evidence, chooses rental comparables, builds a PDF, and stores it.
6. The backend sends a separate Gmail reply for each completed property PDF.
7. An address that cannot be resolved must become `needs_review` or `failed`; it must not block completed properties from being emailed.

---

## Required AWS architecture

```text
Vercel frontend
  │ POST /pipeline/run
  ▼
API Gateway (or Lambda Function URL, protected)
  ▼
Run-dispatch Lambda
  ├── loads OAuth/token and job state
  ├── calls Gmail API to discover CSV attachments
  ├── writes CSV attachment to S3
  ├── creates idempotent job + property rows in Postgres
  └── sends one SQS message for each property row
           │
           ▼
      SQS: property-report queue
           │
           ▼
      Report-worker Lambda (one property per message)
        ├── resolve/property search
        ├── fetch comparison evidence from Cotality
        ├── build the PDF
        ├── upload PDF to S3
        ├── update property row in Postgres
        └── enqueue a delivery check
           │
           ▼
      SQS: delivery queue
           │
           ▼
      Delivery Lambda
        ├── checks all rows for a job
        ├── sends each generated PDF once through Gmail API
        └── records delivery idempotency markers

AWS Secrets Manager
  ├── Gmail OAuth client credentials
  ├── encrypted Gmail refresh-token encryption key
  ├── Cotality client credentials
  └── Postgres connection URL

S3
  ├── source CSV attachments
  └── generated rent-review PDFs

Postgres / Neon (retain initially)
  ├── Gmail connection record
  ├── pipeline jobs
  ├── property-report rows
  ├── outgoing email attempts
  └── immutable job-event audit history
```

### Services deliberately not included

- **No EventBridge Scheduler / cron.** The Vercel frontend is the only trigger for now.
- No long-running worker process.
- No browser automation, Gmail password, cookie, or Browserless dependency.

---

## Lambda responsibilities

### 1. Run-dispatch Lambda

Triggered only by the Vercel frontend.

Responsibilities:

1. Authenticate the Vercel request with a signed service token or JWT.
2. Load the connected Gmail account and refresh the OAuth access token.
3. Query Gmail for candidate messages, for example:

   ```text
   has:attachment filename:csv -from:me
   ```

4. Download eligible CSV attachments through Gmail API.
5. Validate CSV columns. Required address aliases are `address`, `property address`, or `full address`.
6. Create an idempotency key from Gmail message ID plus attachment identity/content hash.
7. Store the raw CSV in S3.
8. Create a job and one property row per CSV line in Postgres.
9. Send one SQS report message per pending property row.
10. Return quickly to the frontend with `202 Accepted`, job ID, and row count.

It must not generate PDFs itself.

### 2. Report-worker Lambda

Triggered by one SQS message representing one property row.

Responsibilities:

1. Claim the row transactionally in Postgres so duplicate SQS deliveries cannot generate two PDFs.
2. Match the CSV address to a Cotality property ID.
3. Load reference attributes and rental comparables using the API plan below.
4. Generate the branded PDF with property and comparable images.
5. Save the PDF to S3 with this filename pattern:

   ```text
   {property-name-slug}-{YYYY-MM-DD}.pdf
   ```

6. Update the row to `generated`, including PDF object key and email-market values.
7. Send a delivery-check message to SQS.

On permanent data errors, set `needs_review` with an actionable reason. On temporary upstream errors, throw so SQS retries with backoff.

### 3. Delivery Lambda

Triggered after reports complete. It may receive duplicate messages and must be idempotent.

Responsibilities:

1. Query all rows for the job.
2. Email every `generated` report that does not already have a successful delivery marker.
3. Do **not** wait for an unresolved property. Send completed reports individually and leave `needs_review`/failed rows visible in the dashboard.
4. Build the existing email body from available data only:
   - owner name(s) and owner email from CSV;
   - property address;
   - bedrooms from reference attributes;
   - local market rent low/high and average from selected comparable rents;
   - current rent from CSV;
   - suggestion wording based on current rent versus achievable/average rent;
   - closing name `Vincent`.
5. Record outgoing Gmail message ID and the property-report delivery marker in Postgres before treating the delivery as complete.

---

## Cotality API map for the report-worker

Use the existing Cotality client-credentials OAuth flow. Cache bearer tokens until shortly before expiry. Do not put client secrets in the frontend or Lambda source.

### A. Address resolution / reference property identity

| API | Purpose | Required output |
| --- | --- | --- |
| `GET /property/au/v2/suggest.json?q={address}` | Find/confirm the exact Cotality property ID from the CSV address. | `propertyId`, `streetId`, `localityId`, formatted suggestion/address. |
| `GET /search/au/property/street/{streetId}?page={page}` | Retrieve property summaries for the exact property ID after suggestion. This supplies usable reference property details and photo data. | address, configuration attributes, location identifiers, coordinates when present, property photo. |

Important: street searches can be dense for apartment buildings. The implementation must page in bounded, concurrent batches (for example, 8 requests at a time; configurable maximum 75 pages). If the exact ID cannot be found after the configured bound, mark the row `needs_review`; do not invent configuration from a different unit.

### B. Reference-property configuration used for similarity scoring

Use the property summary returned by the exact street search above.

| Field | PDF / scoring use |
| --- | --- |
| property type | Match candidate type. |
| bedrooms | Match score and email body. |
| bathrooms | Match score. |
| car spaces | Match score. |
| floor area / land area | Area similarity score when present. |
| locality ID | Context and validation; do not rely on it as the only candidate source. |
| coordinates | Haversine distance if present. |
| default property photo | Reference-property image in PDF. |

### C. Candidate-property discovery, rental evidence, and configuration

| API | Purpose | Required output |
| --- | --- | --- |
| `POST /property/au/v1/property/comparables.json` | Primary candidate source. Call with target `propertyId`, rental comparable rule, requested candidate detail and statistics. | rental campaign amount/period, candidate address, property ID, type, beds/baths/cars, areas, coordinates/distance, available candidate photo URLs. |

Use the Cotality rental-comparables rule currently configured as rule `3`. Request detailed comparable categories and return fields required for address/attributes. Do not fabricate sale valuation fields for a rent review.

Candidate scoring:

```text
property type exact match       35
bedrooms exact / ±1             20 / 10
bathrooms exact / ±1            15 / 7
car spaces exact / ±1           10 / 5
similar usable floor/land area  10
distance from reference          0–10
```

Select the strongest rental candidates first, but include at least five candidate properties where available, even when scores fall below 60. The final rent summary uses selected weekly-rent candidates only.

### D. Candidate image enrichment

| API | Purpose |
| --- | --- |
| `GET /property/au/v2/suggest.json?q={candidate address}` | Confirm candidate property ID/street mapping before enrichment. |
| `GET /search/au/property/street/{streetId}?page={page}` | Retrieve the exact candidate property summary and default photo when the comparables response does not include an image. |

Image rules:

- Prefer Cotality image URL from the comparables response.
- Fall back to exact candidate summary image only after ID verification.
- Never use a photo from a similar address or a different apartment unit.
- A missing image must render a PDF placeholder; it must not fail the report.
- Convert WebP images to JPEG/PNG before PDF embedding when needed.

### APIs not needed for this rent-review pipeline

- AVM/rental AVM: optional; do not block report generation.
- Timeline, legal, ownership, commercial tenants, construction projects, property bureau, insurance/SumSure: not required for the current report.
- Legacy property-details endpoints that returned `503`: do not make them a dependency of the Lambda report worker.

---

## Cotality rate-limit and resilience requirements

Do not assume a numeric Cotality quota. Make all limits configurable from environment variables/Secrets Manager.

### Required controls

1. **Global concurrency cap**
   - Start with `2` concurrent report-worker Lambda executions.
   - Set SQS event-source `maximumConcurrency` to the same value.
   - Reserve Lambda concurrency so unrelated functions cannot starve the report workers.

2. **Per-report API concurrency cap**
   - At most `3` Cotality requests in flight for one property.
   - Street-page enrichment batches: maximum `8` concurrent pages.
   - Candidate photo enrichment: maximum `3` concurrent candidates.

3. **Token caching**
   - Cache Cotality OAuth token in memory for warm Lambda invocations.
   - Optionally store token expiry in DynamoDB/Parameter Store only if cross-instance reuse is necessary.
   - Refresh early; never request a token for every Cotality call.

4. **Retry policy**
   - Retry only transient statuses: `429`, `500`, `502`, `503`, `504`, network timeout.
   - Use exponential backoff with full jitter, for example 1s, 2s, 4s, 8s, capped at 30s.
   - Respect `Retry-After` when Cotality provides it.
   - Never retry `400`, `401`, `403`, or a verified `404` as though they were temporary.

5. **Circuit breaker**
   - When repeated `429`/`503` responses occur, pause new Cotality work for a short configurable cooldown.
   - Let SQS visibility timeout and retry policy handle delayed work rather than hot-looping.

6. **Caching**
   - Cache suggest, exact property summary, and comparables responses for about five minutes using a key that includes property ID/address and request shape.
   - Cache only successful responses; do not cache error responses as a success.

7. **Observability**
   - Emit structured logs: endpoint category, HTTP status, retry number, latency, cache hit/miss, property-row ID.
   - Never log OAuth access tokens, client secrets, refresh tokens, full owner email, or PDF contents.

---

## Data model and idempotency

Retain the current Postgres job model initially.

### Minimum tables/records

- `gmail_connections`: encrypted refresh token, masked email, scopes, connection status.
- `pipeline_jobs`: source Gmail message ID/thread ID, attachment metadata, lifecycle status, retry count.
- `property_reports`: one row per CSV property; matched property ID, status, PDF S3 key, report values, failure reason.
- `reply_attempts`: one record per property report and outgoing email attempt.
- `job_events`: immutable state transitions and safe diagnostics.

### Idempotency rules

- Intake key: Gmail message ID + attachment ID/hash.
- Report key: job ID + property-row ID.
- Delivery key: job ID + property-report ID.
- SQS can deliver the same message more than once. Every Lambda must check/update state transactionally before doing work.
- Do not auto-requeue a permanently failed exact address forever. Expose it as reviewable in Vercel.

---

## Security requirements

- Vercel-to-AWS trigger must be authenticated. Use a signed shared service token stored in Vercel and AWS Secrets Manager, or JWT validation through API Gateway.
- Use AWS Secrets Manager for runtime secrets; Lambda environment variables should contain secret ARNs/configuration, not plaintext secrets where possible.
- Encrypt S3 bucket objects with SSE-S3 or SSE-KMS.
- Bucket must remain private. Provide short-lived presigned URLs only when the authenticated frontend needs a PDF download.
- Use least-privilege IAM roles:
  - dispatcher: SQS send, S3 CSV write, database/secret read;
  - worker: SQS consume, S3 PDF write/read, database/secret read;
  - delivery: SQS consume, database/secret read/write, Gmail network access;
  - Vercel does not receive AWS long-lived credentials.
- Configure SQS dead-letter queues for dispatch, report, and delivery failures.

---

## Lambda settings

| Function | Suggested memory | Timeout | Notes |
| --- | ---: | ---: | --- |
| Run-dispatch | 512 MB | 60 seconds | Discovery and queueing only. |
| Report-worker | 2,048–3,072 MB | 12 minutes | PDF/image work; one property per invocation. |
| Delivery | 512 MB | 60 seconds | One or several lightweight Gmail send operations. |

Lambda has a maximum single-invocation timeout of 15 minutes, which is why the worker must process one property per SQS message. [AWS Lambda timeout documentation](https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html)

---

## Vercel frontend changes

Keep the existing frontend. Replace the GitHub Actions dispatch route with a call to the AWS run-dispatch endpoint.

The frontend needs endpoints/views for:

- start a manual mailbox run;
- display accepted job ID immediately;
- poll job/property statuses from the backend;
- show generated PDF links;
- show `needs_review` rows and their reason;
- retry one failed/review property explicitly;
- show last successful manual scan and any active run.

Do not label a completed Lambda invocation as “worker offline.” Lambdas are expected to stop after completing work.

---

## Deployment and rollout plan

1. Create S3 bucket, three SQS queues with DLQs, Secrets Manager entries, and IAM roles using AWS SAM, CDK, or Terraform.
2. Deploy the Lambdas without changing the Vercel frontend.
3. Add a protected AWS health endpoint and test only Cotality token/address lookup with a known property.
4. Test one report-worker SQS message end-to-end and visually inspect its PDF.
5. Test Gmail discovery with a non-production CSV, but disable delivery or send only to the authorized test mailbox.
6. Test one complete report email and verify idempotency by sending the same SQS message twice.
7. Change Vercel’s Auto-pilot button from GitHub workflow dispatch to AWS run-dispatch.
8. Keep GitHub Actions disabled but available as rollback until AWS completes several successful manual runs.
9. Add CloudWatch dashboards/alarms and DLQ review procedure.

---

## Acceptance criteria

The migration is complete only when all of the following are true:

- Vercel can manually initiate a run without GitHub Actions.
- Gmail OAuth refresh works from Lambda.
- A CSV with ten valid properties produces ten independently tracked report tasks.
- One bad property does not prevent completed-property emails.
- Every completed PDF includes reference image/configuration, candidate details/images when available, comparable rents, branding, and property/date filename.
- Duplicate button clicks, SQS redelivery, and repeated Gmail scans do not duplicate reports or outgoing emails.
- Cotality retries and concurrency limits are active and observable.
- Secrets never appear in source control, frontend responses, or logs.
