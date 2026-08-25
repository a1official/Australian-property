# Authorized crawling guide

The paginator is intended for websites you own, sources whose terms explicitly
permit automated access, and local copies of pages obtained lawfully.

`--authorized` is an acknowledgement by the operator. It does not override a
website's terms, robots directives, authentication requirements, rate limits,
CAPTCHA, or other access controls.

## Do

- Confirm written permission or an applicable published crawling policy before
  running a remote crawl.
- Read the source's terms and `robots.txt` before choosing the URL scope.
- Start with one page and inspect the output before enabling pagination.
- Use a conservative `--max-pages` value and a non-zero `--delay-seconds` value
  for remote sources.
- Follow only the intended same-origin Next link.
- Stop when the source returns HTTP 401, 403, or 429, a CAPTCHA, a challenge
  page, a login wall, or another refusal.
- Prefer a documented API, export, webhook, service account, or IP allowlist
  when the source provides one.
- Preserve crawl timestamps, source URLs, HTTP status, and error details in the
  output so freshness and failures are visible.
- Use localhost for testing saved pages and extraction logic.

## Do not

- Do not use the paginator on a source that prohibits automated access.
- Do not use `--authorized` as a substitute for actual permission.
- Do not attempt to bypass CAPTCHA, bot challenges, authentication, paywalls,
  IP blocks, robots directives, or HTTP 401/403/429 responses.
- Do not rotate identities, proxies, browser fingerprints, cookies, or accounts
  to continue after a refusal.
- Do not remove rate limits or use unbounded pagination.
- Do not collect personal, private, login-gated, or licensed data without the
  corresponding authorization and data-handling controls.
- Do not treat a successful HTTP response as proof that the source permits the
  crawl.

## Recommended remote command

Use this only after confirming that the source permits automation:

```powershell
.\.venv\Scripts\crawl4ai-paginate.exe `
  "https://permitted-source.example/catalog/list-1" `
  --authorized `
  --max-pages 20 `
  --delay-seconds 2 `
  --output "data\source-crawl.json" `
  --verbose
```

## Recommended saved-page command

Serve manually saved pages from localhost, ensure their Next links point to the
next local file, and run:

```powershell
.\.venv\Scripts\crawl4ai-paginate.exe `
  "http://127.0.0.1:8081/list-1.html" `
  --max-pages 20 `
  --delay-seconds 0 `
  --include-html `
  --output "data\local-source-crawl.json" `
  --verbose
```

## Browser-behavior options

Crawl4AI includes optional settings named `enable_stealth`, `simulate_user`,
`override_navigator`, and `magic`. The project paginator does not expose these
as remote-access switches. They are not a guarantee of access and must not be
used to evade a source's restrictions. For a website you operate, configure a
documented crawler identity, API token, service route, or allowlist instead.

## Handling a blocked run

When a run is blocked:

1. Stop the job and retain the error response.
2. Do not retry with stealth, a different identity, or another network path.
3. Confirm permission with the source owner.
4. Request an API, export, allowlist, or test environment.
5. Resume only after the approved access method is documented.
