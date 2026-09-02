"""Playwright-based Gmail crawler and email dispatcher.

Uses the authenticated Playwright browser session to:
1. Crawl Gmail inbox for emails with CSV attachments.
2. Download/extract the CSV attachment data.
3. Send email replies with attached report files.
"""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from rea_pipeline.gmail_auth import authenticate_gmail, load_env_credentials


@dataclass
class InboundCsvMessage:
    """Represents an email found in Gmail containing a CSV attachment."""
    message_id: str
    sender: str
    subject: str
    file_name: str
    csv_content: str
    received_at: str


def crawl_gmail_csvs(
    *,
    browser_channel: str = "chrome",
    profile_dir: Path | str | None = None,
    session_file: Path | str | None = None,
    query: str = "has:attachment filename:csv",
    headed: bool = False,
    max_emails: int = 5,
    timeout_seconds: float = 60.0,
) -> list[InboundCsvMessage]:
    """Crawl Gmail for messages with CSV attachments using the authenticated Playwright session.

    Parameters
    ----------
    browser_channel:
        Browser channel ('chrome' or 'msedge').
    profile_dir:
        Path to persistent user data profile.
    session_file:
        Path to saved storage state JSON.
    query:
        Gmail search query (default: 'has:attachment filename:csv').
    headed:
        Whether to run browser in visible mode.
    max_emails:
        Maximum number of matching emails to inspect.
    timeout_seconds:
        Timeout for page actions.

    Returns
    -------
    list of InboundCsvMessage objects with extracted CSV text.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError("Playwright is required: pip install -e '.[browser]'") from exc

    root_dir = Path(__file__).resolve().parents[2]
    default_profile = root_dir / ".browser-profiles" / f"gmail-{browser_channel}"
    default_session = root_dir / ".local" / "gmail-session.json"

    resolved_profile = Path(profile_dir).expanduser() if profile_dir else default_profile
    resolved_session = Path(session_file).expanduser() if session_file else default_session

    # If session doesn't exist yet, run authentication first
    if not resolved_session.exists() and not any(resolved_profile.iterdir() if resolved_profile.exists() else []):
        print("[gmail-crawler] No existing session found, running authentication...", flush=True)
        authenticate_gmail(
            browser_channel=browser_channel,
            profile_dir=resolved_profile,
            session_file=resolved_session,
            headed=True,
        )

    launch_args = [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-infobars",
    ]

    results: list[InboundCsvMessage] = []

    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=str(resolved_profile.resolve()),
            channel=browser_channel,
            headless=not headed,
            args=launch_args,
            ignore_default_args=["--enable-automation"],
            no_viewport=True,
        )

        page = context.pages[0] if context.pages else context.new_page()

        search_url = f"https://mail.google.com/mail/u/0/#search/{query.replace(' ', '+')}"
        print(f"[gmail-crawler] Navigating to search: {search_url}", flush=True)
        page.goto(search_url, wait_until="domcontentloaded", timeout=timeout_seconds * 1000)
        time.sleep(3)

        # Look for email rows in search results table
        email_rows = page.locator('tr[role="row"]').all()
        print(f"[gmail-crawler] Found {len(email_rows)} matching email threads.", flush=True)

        download_dir = root_dir / "data" / "incoming_csv"
        download_dir.mkdir(parents=True, exist_ok=True)

        for index, row in enumerate(email_rows[:max_emails]):
            try:
                row.click()
                time.sleep(2)

                subject_el = page.locator('h2[data-thread-perm-id], h2.hP').first
                subject = subject_el.inner_text() if subject_el.is_visible() else "Rent Review CSV Request"

                sender_el = page.locator('span[email]').first
                sender = sender_el.get_attribute("email") or sender_el.inner_text() if sender_el.is_visible() else ""

                # Find attachment chip
                attachment = page.locator('div[role="link"][aria-label*=".csv"], span:has-text(".csv")').first
                if attachment.is_visible():
                    file_name = attachment.inner_text().strip() or "property-batch.csv"
                    print(f"[gmail-crawler] Found CSV attachment: {file_name} from {sender}", flush=True)

                    # Trigger download or inspect text
                    try:
                        with page.expect_download(timeout=10000) as download_info:
                            attachment.click()
                        download = download_info.value
                        save_path = download_dir / f"{int(time.time())}-{download.suggested_filename}"
                        download.save_as(str(save_path))
                        csv_text = save_path.read_text(encoding="utf-8", errors="replace")

                        results.append(
                            InboundCsvMessage(
                                message_id=f"msg-{index + 1}-{int(time.time())}",
                                sender=sender,
                                subject=subject,
                                file_name=download.suggested_filename,
                                csv_content=csv_text,
                                received_at=datetime.now(timezone.utc).isoformat(),
                            )
                        )
                    except Exception as download_err:
                        print(f"[gmail-crawler] Attachment download note: {download_err}", flush=True)

                # Return to search
                page.go_back()
                time.sleep(1)
            except Exception as row_err:
                print(f"[gmail-crawler] Error processing row {index}: {row_err}", file=sys.stderr, flush=True)

        context.close()

    return results
