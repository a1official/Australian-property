"""Playwright-based Gmail authentication and session extraction pipeline.

Uses a real installed browser (Google Chrome or Microsoft Edge) rather than
vanilla Chromium to authenticate into Gmail using credentials from `.env`,
handles navigation and sign-in steps, and saves full session tokens and cookies.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def load_env_credentials(env_path: Path | None = None) -> tuple[str, str]:
    """Read GMAIL_USERNAME and GMAIL_PASSWORD from environment or .env file."""
    username = os.environ.get("GMAIL_USERNAME", "").strip()
    password = os.environ.get("GMAIL_PASSWORD", "").strip()

    if not username or not password:
        target_path = env_path or (Path(__file__).resolve().parents[2] / ".env")
        if target_path.exists():
            try:
                content = target_path.read_text(encoding="utf-8")
                for line in content.splitlines():
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    if "=" in line:
                        key, _, val = line.partition("=")
                        key = key.strip()
                        val = val.strip().strip("'\"")
                        if key == "GMAIL_USERNAME" and not username:
                            username = val
                        elif key == "GMAIL_PASSWORD" and not password:
                            password = val
            except Exception as err:
                print(f"[gmail-auth] Warning reading {target_path}: {err}", file=sys.stderr)

    return username, password


def authenticate_gmail(
    *,
    username: str | None = None,
    password: str | None = None,
    headed: bool = True,
    browser_channel: str = "chrome",
    profile_dir: Path | str | None = None,
    session_file: Path | str | None = None,
    timeout_seconds: float = 120.0,
) -> dict[str, Any]:
    """Automate Gmail sign-in with a real browser and extract session tokens.

    Parameters
    ----------
    username:
        Gmail email / username. If omitted, read from GMAIL_USERNAME in .env.
    password:
        Gmail password. If omitted, read from GMAIL_PASSWORD in .env.
    headed:
        If True (default), opens visible browser window so 2FA/prompts can be confirmed.
    browser_channel:
        Browser channel ('chrome' or 'msedge'). Default: 'chrome'.
    profile_dir:
        Directory for persistent browser state (default: .browser-profiles/gmail-chrome).
    session_file:
        Path to save Playwright storage state (default: .local/gmail-session.json).
    timeout_seconds:
        Maximum time to wait for login completion (including 2FA prompts).

    Returns
    -------
    dict with session summary, cookies, and tokens.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError(
            "Playwright is required. Install with: pip install -e '.[browser]'"
        ) from exc

    user, pwd = load_env_credentials()
    username = (username or user).strip()
    password = (password or pwd).strip()

    if not username:
        raise ValueError("GMAIL_USERNAME is not set in .env or arguments.")
    if not password:
        raise ValueError("GMAIL_PASSWORD is not set in .env or arguments.")

    root_dir = Path(__file__).resolve().parents[2]
    default_profile = root_dir / ".browser-profiles" / f"gmail-{browser_channel}"
    default_session = root_dir / ".local" / "gmail-session.json"

    resolved_profile = Path(profile_dir).expanduser() if profile_dir else default_profile
    resolved_session = Path(session_file).expanduser() if session_file else default_session

    resolved_profile.mkdir(parents=True, exist_ok=True)
    resolved_session.parent.mkdir(parents=True, exist_ok=True)

    print(f"[gmail-auth] Starting Gmail login for: {username}", flush=True)
    print(f"[gmail-auth] Using real browser channel: {browser_channel}", flush=True)
    print(f"[gmail-auth] Profile directory: {resolved_profile}", flush=True)

    launch_args = [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-infobars",
        "--start-maximized",
    ]

    with sync_playwright() as playwright:
        try:
            context = playwright.chromium.launch_persistent_context(
                user_data_dir=str(resolved_profile.resolve()),
                channel=browser_channel,
                headless=not headed,
                args=launch_args,
                ignore_default_args=["--enable-automation"],
                no_viewport=True,
            )
        except Exception as err:
            # If Google Chrome is not installed at default path, retry with msedge
            if browser_channel == "chrome" and "Executable doesn't exist" in str(err):
                print("[gmail-auth] Chrome executable not found, trying msedge...", file=sys.stderr, flush=True)
                context = playwright.chromium.launch_persistent_context(
                    user_data_dir=str(resolved_profile.resolve()),
                    channel="msedge",
                    headless=not headed,
                    args=launch_args,
                    ignore_default_args=["--enable-automation"],
                    no_viewport=True,
                )
            else:
                raise

        page = context.pages[0] if context.pages else context.new_page()

        # Navigate to Gmail sign-in
        sign_in_url = "https://accounts.google.com/signin/v2/identifier?service=mail&flowName=GlifWebSignIn&flowEntry=ServiceLogin"
        print(f"[gmail-auth] Navigating to: {sign_in_url}", flush=True)
        page.goto(sign_in_url, wait_until="domcontentloaded", timeout=60000)

        # Check if already authenticated
        current_url = page.url
        print(f"[gmail-auth] Initial page URL: {current_url}", flush=True)
        if "mail.google.com" in current_url or "myaccount.google.com" in current_url:
            print("[gmail-auth] Existing authenticated session detected!", flush=True)
        else:
            # 1. Fill Username/Email
            email_input = page.locator('input[type="email"], #identifierId').first
            try:
                email_input.wait_for(state="visible", timeout=15000)
                print("[gmail-auth] Entering username...", flush=True)
                email_input.click()
                email_input.fill(username)
                time.sleep(1)
                next_btn = page.locator('#identifierNext, button:has-text("Next")').first
                if next_btn.is_visible():
                    next_btn.click()
                else:
                    page.keyboard.press("Enter")
            except Exception as err:
                print(f"[gmail-auth] Note on username input: {err}", flush=True)

            # 2. Wait for Password field
            time.sleep(2)
            pwd_input = page.locator('input[type="password"], input[name="Passwd"]').first
            try:
                pwd_input.wait_for(state="visible", timeout=20000)
                print("[gmail-auth] Entering password...", flush=True)
                pwd_input.click()
                pwd_input.fill(password)
                time.sleep(1)
                pwd_next = page.locator('#passwordNext, button:has-text("Next")').first
                if pwd_next.is_visible():
                    pwd_next.click()
                else:
                    page.keyboard.press("Enter")
            except Exception as err:
                print(f"[gmail-auth] Note on password input: {err}", flush=True)

        # 3. Wait for post-login navigation to Gmail Inbox or account dashboard
        print(f"[gmail-auth] Waiting up to {int(timeout_seconds)}s for authentication to complete...", flush=True)
        start_time = time.time()
        logged_in = False

        while time.time() - start_time < timeout_seconds:
            curr_url = page.url
            if "mail.google.com/mail" in curr_url or "myaccount.google.com" in curr_url:
                logged_in = True
                print(f"[gmail-auth] Successfully reached authenticated URL: {curr_url}", flush=True)
                break
            time.sleep(2)

        # If not redirected to mail yet, try navigating directly to mail.google.com
        if not logged_in:
            try:
                print("[gmail-auth] Trying direct navigation to mail.google.com...", flush=True)
                page.goto("https://mail.google.com/mail/u/0/#inbox", wait_until="domcontentloaded", timeout=30000)
                if "mail.google.com" in page.url:
                    logged_in = True
                    print("[gmail-auth] Reached mail.google.com inbox!", flush=True)
            except Exception as err:
                print(f"[gmail-auth] Direct nav error: {err}", file=sys.stderr, flush=True)

        if not logged_in:
            print(f"[gmail-auth] Notice: Current URL is {page.url}. Saving session state...", file=sys.stderr, flush=True)

        # 4. Save storage state (cookies, local storage, session tokens)
        print(f"[gmail-auth] Saving storage state to: {resolved_session}", flush=True)
        context.storage_state(path=str(resolved_session.resolve()))

        # Keep browser open for 10 seconds so the user can visibly observe the open Gmail page
        if headed:
            print("[gmail-auth] Keeping browser open for 10 seconds so you can see the inbox...", flush=True)
            time.sleep(10)

        # 5. Extract cookies for summary
        cookies = context.cookies()
        session_cookies: dict[str, str] = {}
        for c in cookies:
            name = c.get("name", "")
            if name in {"SID", "HSID", "SSID", "APISID", "SAPISID", "OSID", "LSID", "__Secure-1PSID", "__Secure-3PSID"}:
                session_cookies[name] = c.get("value", "")

        cookies_file = resolved_session.parent / "gmail-cookies.json"
        cookies_file.write_text(json.dumps(cookies, indent=2), encoding="utf-8")

        summary = {
            "email": username,
            "authenticated": logged_in,
            "authenticated_at": datetime.now(timezone.utc).isoformat(),
            "storage_state_path": str(resolved_session.resolve()),
            "cookies_path": str(cookies_file.resolve()),
            "profile_dir": str(resolved_profile.resolve()),
            "session_cookies": session_cookies,
            "total_cookies": len(cookies),
        }

        summary_file = resolved_session.parent / "gmail-auth-summary.json"
        summary_file.write_text(json.dumps(summary, indent=2), encoding="utf-8")

        print(f"[gmail-auth] Successfully saved {len(cookies)} cookies (Session IDs: {list(session_cookies.keys())})", flush=True)
        print(f"[gmail-auth] Summary written to: {summary_file}", flush=True)

        context.close()
        return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="gmail-login",
        description="Authenticate into Gmail using real browser Playwright and save session tokens.",
    )
    parser.add_argument("--username", help="Gmail username / email (defaults to GMAIL_USERNAME in .env)")
    parser.add_argument("--password", help="Gmail password (defaults to GMAIL_PASSWORD in .env)")
    parser.add_argument(
        "--browser-channel",
        choices=["chrome", "msedge"],
        default="chrome",
        help="Real browser channel to automate (default: chrome)",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Run in headless mode (default is headed to allow 2FA confirmation)",
    )
    parser.add_argument(
        "--profile-dir",
        type=Path,
        help="Custom directory to store persistent browser profile",
    )
    parser.add_argument(
        "--session-file",
        type=Path,
        help="Path where Playwright storage state JSON will be saved",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=120.0,
        help="Timeout in seconds to wait for login / 2FA completion (default: 120)",
    )

    args = parser.parse_args(argv)

    try:
        summary = authenticate_gmail(
            username=args.username,
            password=args.password,
            headed=not args.headless,
            browser_channel=args.browser_channel,
            profile_dir=args.profile_dir,
            session_file=args.session_file,
            timeout_seconds=args.timeout,
        )
        print(json.dumps(summary, indent=2))
        return 0
    except Exception as exc:
        print(f"[gmail-auth] Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
