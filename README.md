# REA rental-data pipeline

This repository contains a small ingestion pipeline for rental listings exposed
in the initial page state of a successfully loaded realestate.com.au search
page. It reads `window.ArgonautExchange`, normalizes the useful comparable
fields, and upserts them into SQLite.

`ArgonautExchange` is page presentation data, not a documented public API. Its
shape can change without notice. Use this collector only where you have a lawful
right to access and retain the data, and follow the site's terms, robots rules,
rate limits, and applicable data-licensing requirements. The collector does not
bypass access controls, manufacture protection tokens, or collect tenant data.

## What is stored

- listing ID and canonical URL
- address, suburb, state, postcode, and property type
- bedrooms, bathrooms, parking, and studies
- displayed price and normalized weekly rent when it can be calculated
- availability, bond, building/land size, inspections, description, agency,
  and main image URL
- run metadata and the source listing JSON for audit/debugging

Search metadata such as the total result count and current/max page is recorded
with every ingestion run. Coordinates and actual leased prices are not normally
present in this search payload and require licensed sources or a separate
geocoding/enrichment step.

## Quick start

No third-party runtime package is needed for archived pages or saved HTML. Set
up the project in an isolated environment first:

```powershell
cd D:\Realstate
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e .

python -m rea_pipeline ingest `
  "https://web.archive.org/web/20250614064218id_/https://www.realestate.com.au/rent/in-sydney,+nsw/list-1" `
  --database data/realstate.db

python -m rea_pipeline list --database data/realstate.db --limit 5
```

For a normal browser session, install the optional browser support. The
source scraper uses the locally installed Google Chrome by default; the older
embedded-page-state collector below still uses Playwright's Chromium runtime:

```powershell
python -m pip install -e ".[browser]"
playwright install chromium
python -m rea_pipeline ingest `
  "https://www.realestate.com.au/rent/in-sydney,+nsw/list-1" `
  --mode browser --headed --database data/realstate.db
```

`--mode auto` tries direct HTTP first and then the optional browser collector.
`--mode browser` uses ordinary Playwright navigation and evaluates
`window.ArgonautExchange` in the loaded page. If the website refuses the
request, the pipeline exits with a clear error rather than attempting to evade
the restriction.

Saved HTML is also supported:

```powershell
python -m rea_pipeline ingest .\search-page.html --database data/realstate.db
```

## Query stored listings

Queries run only against normalized records already stored in SQLite; they do
not trigger a website crawl. Filter by location, property characteristics, rent,
or free text, then paginate and sort the result:

```powershell
python -m rea_pipeline query `
  --database data/realstate.db `
  --state NSW --suburb Sydney `
  --property-type apartment `
  --bedrooms-min 2 `
  --weekly-rent-min 500 --weekly-rent-max 900 `
  --sort-by weekly_rent --sort-order asc `
  --limit 20 --offset 0
```

The same query layer is exposed through the local API:

```text
GET /api/v1/listings?state=NSW&suburb=Sydney&bedrooms_min=2&weekly_rent_max=900
```

The response contains `total`, `limit`, `offset`, and `items`. Supported sort
fields are `last_seen_at`, `first_seen_at`, `weekly_rent`, `bedrooms`,
`bathrooms`, and `suburb`.

### Free ABS local-market context

The API can enrich a listing search with official, postcode-level 2021 Census
QuickStats and SEIFA context. No ABS account, API key, ABN, or ACN is required.

```text
GET /api/v1/market-context/abs?postcode=2000
```

The normalized response includes population, median age, private dwellings,
household income, Census rent, mortgage repayment, household size, and available
SEIFA national rankings. Results are cached in memory for 24 hours. Treat these
figures as historical local context, not current asking rents or property
valuations.

## Next.js property search

The frontend under `frontend/` searches the stored query API through a Next.js
server route. It never connects to SQLite from the browser and does not trigger
a live website crawl.

Run the Python API in the first terminal:

```powershell
cd D:\Realstate
.\.venv\Scripts\rea-api.exe --host 127.0.0.1 --port 8000
```

Run the frontend in a second terminal:

```powershell
cd D:\Realstate\frontend
pnpm install
pnpm dev
```

Open `http://127.0.0.1:3000`. Set `REA_API_BASE_URL` in
`frontend/.env.local` only when the Python API uses a different address.

### Deploy the Cotality property application to Vercel

The production application is the Next.js project in `frontend/`. Import this
repository in Vercel and set **Root Directory** to `frontend`. Vercel detects
the included `vercel.json` and uses `pnpm build`.

Set these server-side Vercel Environment Variables for every deployment
environment that needs Cotality data:

```text
CORELOGIC_CLIENT_ID=
CORELOGIC_CLIENT_SECRET=
CORELOGIC_SANDBOX_BASE_URL=https://api-sbox.corelogic.asia
```

Do not prefix these names with `NEXT_PUBLIC_`; the credentials must remain in
the server-side route handlers. The application does not require the local
Python API for its Cotality property-search and CSV-report workflow.

## Crawl4AI Next-link paginator

`crawl4ai-paginate` accepts an authorized starting URL, follows only an explicit
same-origin Next link, and stores all page results in one JSON document. It
checks robots directives, bypasses Crawl4AI's cache, detects repeated pages,
and stops when Next is absent or the safety limit is reached.

```powershell
cd D:\Realstate

.\.venv\Scripts\crawl4ai-paginate.exe `
  "https://permitted-source.example/catalog/list-1" `
  --authorized `
  --max-pages 20 `
  --delay-seconds 2 `
  --output data\source-crawl.json `
  --verbose
```

If the source uses an icon-only or unusually labelled control, provide its CSS
selector with `--next-selector`, for example `--next-selector "a.pagination-next"`.
The JSON reports `page_count`, `stop_reason`, and a `pages` array containing each
page's URL, status, title, Markdown, links, and discovered `next_url`. Remote
targets require `--authorized`; localhost targets do not.

Before running a remote crawl, read
[`docs/AUTHORIZED_CRAWLING.md`](docs/AUTHORIZED_CRAWLING.md). The
`--authorized` flag records operator acknowledgement; it does not override a
source's terms, robots directives, authentication, rate limits, or bot
protection.

## Development

```powershell
python -m pip install -e ".[dev]"
pytest
```

## Core engine

The `engine` package converts normalized source records into an explainable
market recommendation, optional tenant score, structured report, and minimized
audit event. The current SQLite connector reads listings collected by the REA
pipeline; licensed market and Property Tree connectors can implement the same
contracts later.

Run a development report against the archived sample data:

```powershell
python -m engine `
  --database data\realstate.db `
  --property-id PT-DEMO-001 `
  --address "10 Example Street, Sydney NSW 2000" `
  --suburb Sydney --state NSW --postcode 2000 `
  --property-type apartment `
  --bedrooms 1 --bathrooms 1 --parking 0 `
  --current-rent 800 `
  --max-age-days 730 `
  --output data\engine-report.html
```

The primary output is a self-contained, responsive and print-ready HTML report.
Use `--json-output data\engine-report.json` only when a downstream system also
needs the machine-readable representation.

The extended age window is necessary only because the current development
dataset is an archived June 2025 snapshot. Production runs should use a strict
freshness limit and an authorised current market source.

## Query-driven source scrapers

The `source_scrapers` package puts a common query model in front of each source.
REA is currently executable. It does not call or inspect internal listing APIs
and does not read `window.ArgonautExchange`: Playwright opens the public home
page, selects Rent, fills the public location search control, submits it, and
then BeautifulSoup parses the rendered listing cards. Property Tree, RP Data, Pricefinder, and the
supplementary provider are registered but fail closed until their authorised
API/export details and field mappings are supplied.

Inspect connector readiness without making a network request:

```powershell
python -m source_scrapers sources
```

Preview the REA browser actions and normalized input:

```powershell
python -m source_scrapers search --dry-run `
  --source realestate.com.au `
  --suburb Parramatta --state NSW --postcode 2150 `
  --property-type apartment --bedrooms-min 2 `
  --bathrooms-min 1 --weekly-price-min 500 --weekly-price-max 850
```

Run it through Playwright and store matching rows:

```powershell
python -m source_scrapers search `
  --source realestate.com.au --headed --browser-channel chrome `
  --suburb Parramatta --state NSW --postcode 2150 `
  --property-type apartment --bedrooms-min 2 `
  --bathrooms-min 1 --weekly-price-min 500 --weekly-price-max 850 `
  --max-pages 2 --max-results 50 --database data\realstate.db
```

`--browser-channel chrome` is the default and runs the installed Google Chrome
binary. To retain cookies and site preferences between runs, use a dedicated
automation profile:

```powershell
python -m source_scrapers search `
  --source realestate.com.au --headed --browser-channel chrome `
  --profile-dir .browser-profiles\rea-chrome `
  --suburb Parramatta --state NSW --postcode 2150
```

Do not point `--profile-dir` at Chrome's normal `User Data` directory. Chrome
does not support automating its default profile, and a user-data directory can
only be used by one running browser instance. The dedicated directory above is
ignored by Git and can safely hold only this scraper's session state.

The browser collector does not inspect network responses or embedded page-state
objects. It interacts with the public search controls and captures `page.content()`
after the results render. BeautifulSoup extracts visible cards and every returned
row is then checked locally against the full input query before it is stored.
Pagination uses the visible Next control. Access refusals and rate limits are
returned as errors rather than bypassed.

The API worker runs Chrome headlessly, so no window appears. Use `--headed` on
the CLI when you want to watch the browser. If REA refuses the initial page
(for example with HTTP 429), the headed window can close quickly because the
run has already failed and browser resources are cleaned up.

### Source reliability controls

`source_scrapers.reliability` provides shared controls for authorised source
connectors:

- a cross-process minimum request interval;
- deterministic, capped exponential backoff and `Retry-After` parsing;
- a persistent circuit breaker after repeated failures;
- query-keyed JSON response caching; and
- stable-field row deduplication.

REA public-page automation is configured fail-closed: it is never retried after
a refusal, does not cache REA responses, and one HTTP 401/403/429 opens a
24-hour circuit in `data\source_reliability.db`. This protects the source from
scheduled retry loops; it is not a mechanism for bypassing access controls.

Inspect the current circuit state without making a network request:

```powershell
python -m source_scrapers reliability-status
```

The cache and bounded backoff helpers are intended for API or export connectors
where the provider contract explicitly permits automated access.

## Property Tree browser asset inventory

Property Tree uses a normal OAuth/OIDC login flow. The asset collector opens the
official agent URL in Playwright and saves JavaScript delivered to that browser
from Property Tree/MRI hosts. It never persists cookies, credentials,
authorization headers, tokens, or API response bodies.

Capture the public login assets:

```powershell
property-tree-assets
```

To inspect assets available after a legitimate team login, use a local ignored
browser profile and complete login/MFA yourself in the headed window:

```powershell
property-tree-assets --headed `
  --profile-dir .browser-profiles\property-tree `
  --login-wait-seconds 180
```

Bundles are saved under `artifacts\property-tree-bundles`; endpoint-shaped
strings and hashes are written to `manifest.json`. Candidates are inventory only
and are not called automatically. Use MRI Information eXchange or another
approved integration contract for production data access.

## REA sitemap and HTTP API

The purpose-based public-page sitemap is stored in
`src\rea_api\rea_sitemap.json` and exposed by `GET /api/v1/sitemap`. It covers
rent, buy, sold, listing detail, property profile, suburb profile, agent, and
agency page families. Each entry records its browser navigation, parser,
attributes, API route, and implementation status.

Install and start the local API:

```powershell
python -m pip install -e ".[api,browser]"
rea-api --host 127.0.0.1 --port 8000
```

OpenAPI documentation is available locally at `http://127.0.0.1:8000/docs`.
Rent-search jobs return HTTP 202 and execute the existing Playwright UI plus
BeautifulSoup card parser in the background. Other purpose routes currently
return HTTP 501 until their rendered-page parsers are implemented; this is
intentional so unimplemented collection is never represented as successful.

## REA Partner Listing Export

The API and frontend also support the official REA Partner Platform Listing
Export API for customer-authorised rental listings. This connector uses OAuth
2.0 client credentials on the Python server, imports current rental listings in
REAXML format, and stores normalized records in the existing SQLite index. It
does not expose credentials to the browser and cannot search listings belonging
to agencies that have not authorised the partner integration.

After REA grants the `listing:listings:export` scope, configure the server:

```text
REA_PARTNER_CLIENT_ID=...
REA_PARTNER_CLIENT_SECRET=...
REA_PARTNER_AGENCY_ID=ABC123
REA_SYNC_ADMIN_TOKEN=use-a-long-random-value
```

For the Next.js server, copy `frontend/.env.example` to
`frontend/.env.local`, set the same `REA_SYNC_ADMIN_TOKEN`, and explicitly set
`REA_ENABLE_UI_SYNC=true` in production if authorised users should be able to
start a sync from the website. The UI first synchronizes authorised records and
then searches the local normalized index.
