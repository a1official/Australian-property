"""Full Gmail Playwright Automation Pipeline with Checkpointing.

End-to-end workflow:
1. Opens Gmail using a real browser (Google Chrome/Edge) and saved session.
2. Crawls for unread/incoming emails containing CSV attachments.
3. Consults persistent checkpoint ledger (`data/gmail_checkpoints.json`) to skip already processed CSVs.
4. Downloads and extracts new CSV property lists.
5. Feeds properties through the Core Engine report generation pipeline to generate standalone HTML reports.
6. Automatically composes and sends an email reply to the original sender with all generated reports attached.
7. Commits completed status to the checkpoint ledger.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from engine.comparables import ComparableEngine, ComparableEngineConfig
from engine.connectors import JsonlAuditSink
from engine.html_report import render_html_report
from engine.models import SubjectProperty
from engine.orchestrator import CoreEngine
from engine.sqlite_market import SQLiteMarketConnector
from rea_pipeline.gmail_auth import authenticate_gmail, load_env_credentials


# ---------------------------------------------------------------------------
# Checkpoint Ledger System
# ---------------------------------------------------------------------------

@dataclass
class CheckpointRecord:
    key: str
    sender: str
    subject: str
    file_name: str
    csv_hash: str
    downloaded_at: str
    property_count: int = 0
    report_files: list[str] = field(default_factory=list)
    reply_sent: bool = False
    reply_sent_at: str | None = None
    error: str | None = None


class CheckpointManager:
    """Manages persistent state of processed email attachments to prevent duplicate processing."""

    def __init__(self, checkpoint_path: Path | str | None = None) -> None:
        root_dir = Path(__file__).resolve().parents[2]
        self.path = Path(checkpoint_path).expanduser() if checkpoint_path else (root_dir / "data" / "gmail_checkpoints.json")
        self.records: dict[str, CheckpointRecord] = {}
        self.load()

    def load(self) -> None:
        if self.path.exists():
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                for k, v in data.get("processed_messages", {}).items():
                    self.records[k] = CheckpointRecord(**v)
            except Exception as err:
                print(f"[checkpoint] Warning loading {self.path}: {err}", file=sys.stderr, flush=True)

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "last_updated": datetime.now(timezone.utc).isoformat(),
            "total_processed": len(self.records),
            "processed_messages": {k: asdict(v) for k, v in self.records.items()},
        }
        self.path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def make_key(self, sender: str, subject: str, file_name: str, csv_content: str) -> str:
        content_hash = hashlib.sha256(csv_content.encode("utf-8", errors="ignore")).hexdigest()[:16]
        raw_key = f"{sender.lower().strip()}|{subject.strip()}|{file_name.strip()}|{content_hash}"
        return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()[:24]

    def is_completed(self, key: str) -> bool:
        rec = self.records.get(key)
        return bool(rec and rec.reply_sent)

    def register_inbound(self, key: str, sender: str, subject: str, file_name: str, csv_content: str) -> CheckpointRecord:
        csv_hash = hashlib.sha256(csv_content.encode("utf-8")).hexdigest()
        if key not in self.records:
            self.records[key] = CheckpointRecord(
                key=key,
                sender=sender,
                subject=subject,
                file_name=file_name,
                csv_hash=csv_hash,
                downloaded_at=datetime.now(timezone.utc).isoformat(),
            )
            self.save()
        return self.records[key]

    def update_reports(self, key: str, property_count: int, report_files: list[str]) -> None:
        if key in self.records:
            self.records[key].property_count = property_count
            self.records[key].report_files = report_files
            self.save()

    def mark_sent(self, key: str) -> None:
        if key in self.records:
            self.records[key].reply_sent = True
            self.records[key].reply_sent_at = datetime.now(timezone.utc).isoformat()
            self.save()

    def mark_error(self, key: str, error: str) -> None:
        if key in self.records:
            self.records[key].error = error
            self.save()


# ---------------------------------------------------------------------------
# Address Parsing & Report Generation
# ---------------------------------------------------------------------------

STATE_PATTERN = r"\b(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b"
POSTCODE_PATTERN = r"\b(\d{4})\b"


def parse_australian_address(raw: str) -> dict[str, Any]:
    """Extract street address, suburb, state, and postcode from a single address string."""
    clean = re.sub(r"\s+", " ", raw.strip())
    state_match = re.search(STATE_PATTERN, clean, re.IGNORECASE)
    postcode_match = re.search(POSTCODE_PATTERN, clean)

    state = state_match.group(1).upper() if state_match else "NSW"
    postcode = postcode_match.group(1) if postcode_match else "2000"

    # Remove state and postcode to isolate street and suburb
    without_state_pc = re.sub(STATE_PATTERN, "", clean, flags=re.IGNORECASE)
    without_state_pc = re.sub(POSTCODE_PATTERN, "", without_state_pc).strip(", ")

    parts = [p.strip() for p in without_state_pc.split(",") if p.strip()]
    if len(parts) >= 2:
        street = parts[0]
        suburb = parts[-1]
    else:
        words = without_state_pc.split()
        if len(words) >= 3:
            suburb = words[-1]
            street = " ".join(words[:-1])
        else:
            street = without_state_pc
            suburb = "Sydney"

    return {
        "address": clean,
        "street": street,
        "suburb": suburb,
        "state": state,
        "postcode": postcode,
    }


def generate_reports_for_csv(
    csv_text: str,
    batch_name: str,
    database_path: Path | None = None,
    headed: bool = False,
    saved_csv_path: Path | None = None,
) -> tuple[list[Path], list[dict[str, Any]]]:
    """Generate Cotality Parcel Atlas HTML reports for every valid address row in the CSV."""
    import subprocess
    root_dir = Path(__file__).resolve().parents[2]
    db_path = database_path or (root_dir / "data" / "realstate.db")
    output_dir = root_dir / "data" / "reports" / batch_name
    output_dir.mkdir(parents=True, exist_ok=True)

    # Ensure CSV is saved on disk for cotality:batch script
    csv_file = saved_csv_path
    if not csv_file or not csv_file.exists():
        csv_file = root_dir / "data" / "incoming_csv" / f"{batch_name}.csv"
        csv_file.parent.mkdir(parents=True, exist_ok=True)
        csv_file.write_text(csv_text, encoding="utf-8")

    generated_files: list[Path] = []
    summary_items: list[dict[str, Any]] = []

    # 1. Primary: Run `pnpm cotality:batch` command pipeline
    try:
        csv_arg = str(csv_file.resolve())
        out_arg = str(output_dir.resolve())

        # Prefer the Vercel-hosted app; fall back to localhost for local dev
        import os
        base_url = os.environ.get(
            "PARCEL_ATLAS_BASE_URL",
            "https://australian-property.vercel.app",
        ).rstrip("/")

        print(f'[pipeline] Invoking Cotality batch against {base_url} with CSV: "{csv_arg}"', flush=True)
        frontend_dir = root_dir / "frontend"

        # On Windows, shell=True requires a single string (not a list).
        headed_flag = " --headed" if headed else ""
        shell_cmd = (
            f'pnpm cotality:batch -- --csv "{csv_arg}" --output-dir "{out_arg}"'
            f' --base-url "{base_url}"{headed_flag}'
        )

        proc = subprocess.run(
            shell_cmd,
            cwd=str(frontend_dir),
            capture_output=True,
            text=True,
            timeout=300,
            shell=True,
        )

        if proc.returncode == 0:
            html_files = [f for f in output_dir.glob("*.html") if not f.name.startswith("00-")]
            if html_files:
                generated_files.extend(html_files)
                for f in html_files:
                    summary_items.append({
                        "property_id": f.stem,
                        "address": f.stem.replace("-", " "),
                        "suburb": "",
                        "suggested_rent": 0,
                        "file": str(f),
                    })
                print(f"[pipeline] pnpm cotality:batch successfully generated {len(html_files)} report(s).", flush=True)
        else:
            print(f"[pipeline] cotality:batch output note: {proc.stderr or proc.stdout}", flush=True)
    except Exception as cmd_err:
        print(f"[pipeline] Note invoking cotality:batch ({cmd_err}), falling back to internal engine...", flush=True)

    # 2. Fallback: If cotality:batch didn't generate reports (e.g. localhost:3004 was offline), use CoreEngine
    if not generated_files:
        print("[pipeline] Running internal CoreEngine fallback...", flush=True)
        reader = csv.DictReader(io.StringIO(csv_text))
        rows = list(reader)
        if not rows:
            raw_rows = list(csv.reader(io.StringIO(csv_text)))
            if raw_rows:
                header = raw_rows[0]
                addr_idx = next((i for i, col in enumerate(header) if re.search(r"address", col, re.I)), 0)
                rows = [{"address": r[addr_idx]} for r in raw_rows[1:] if len(r) > addr_idx and r[addr_idx].strip()]

        engine = CoreEngine(
            comparable_engine=ComparableEngine(
                ComparableEngineConfig(radius_km=5.0, maximum_age_days=730, minimum_score=50.0, maximum_comparables=8)
            ),
            audit_sink=JsonlAuditSink(output_dir / "audit.jsonl"),
        )
        market_connector = SQLiteMarketConnector(db_path)

        for index, row in enumerate(rows):
            addr_val = (
                row.get("address")
                or row.get("property address")
                or row.get("full address")
                or row.get("Address")
                or next((v for k, v in row.items() if "address" in k.lower()), "")
            )
            if not addr_val or not addr_val.strip():
                continue

            parsed = parse_australian_address(addr_val)
            prop_id = str(row.get("property_id") or row.get("reference_id") or f"PROP-{index + 1:03d}").strip()
            prop_type = row.get("property_type") or row.get("type") or "apartment"
            beds = int(row.get("bedrooms") or row.get("beds") or 2)
            baths = int(row.get("bathrooms") or row.get("baths") or 1)
            cars = int(row.get("parking") or row.get("cars") or 1)
            current_rent = int(row.get("current_rent") or row.get("rent") or 750)

            subject = SubjectProperty(
                property_id=str(prop_id),
                address=parsed["address"],
                suburb=parsed["suburb"],
                state=parsed["state"],
                postcode=parsed["postcode"],
                property_type=prop_type,
                bedrooms=beds,
                bathrooms=baths,
                parking_spaces=cars,
                current_weekly_rent=current_rent,
            )

            try:
                records = market_connector.fetch(subject)
                report = engine.run(subject, records)
                html_content = render_html_report(report)

                safe_name = re.sub(r"[^a-zA-Z0-9_-]", "-", f"{prop_id}-{parsed['suburb']}")
                report_file = output_dir / f"{safe_name}.html"
                report_file.write_text(html_content, encoding="utf-8")
                generated_files.append(report_file)

                summary_items.append({
                    "property_id": prop_id,
                    "address": parsed["address"],
                    "suburb": parsed["suburb"],
                    "suggested_rent": getattr(report.market, "suggested_weekly_rent", current_rent),
                    "file": str(report_file),
                })
                print(f"[pipeline] Generated report: {report_file.name}", flush=True)
            except Exception as err:
                print(f"[pipeline] Error generating report for {addr_val}: {err}", file=sys.stderr, flush=True)


    # Build Index / Summary Document
    if generated_files:
        index_file = output_dir / "00-Batch-Summary-Index.html"
        items_html = "".join(
            f"<li><strong>{item['address']}</strong> — Suggested Rent: ${item['suggested_rent']}/wk "
            f"(<a href='{Path(item['file']).name}'>View Report</a>)</li>"
            for item in summary_items
        )
        index_content = f"""<!doctype html>
<html><head><meta charset='utf-8'><title>Batch Report Summary — {batch_name}</title>
<style>body{{font-family:Arial,sans-serif;background:#f4f1e8;color:#172022;padding:40px}}
.card{{background:white;padding:30px;max-width:800px;margin:auto;box-shadow:0 2px 8px rgba(0,0,0,.08)}}
h1{{font-family:Georgia,serif;font-size:28px}}li{{margin:12px 0;line-height:1.4}}a{{color:#0d9488}}</style></head>
<body><div class='card'><h1>Batch Rent Review Reports</h1>
<p>Generated {len(generated_files)} report(s) on {datetime.now().strftime('%d %b %Y %H:%M')}.</p>
<ul>{items_html}</ul></div></body></html>"""
        index_file.write_text(index_content, encoding="utf-8")
        generated_files.insert(0, index_file)

    return generated_files, summary_items


# ---------------------------------------------------------------------------
# Playwright Email Reply Dispatcher
# ---------------------------------------------------------------------------

def send_reply_via_playwright(
    page: Any,
    recipient: str,
    subject: str,
    report_files: list[Path],
    body_text: str = "",
) -> bool:
    """Compose and send an email reply in Gmail with attached report files using Playwright."""
    try:
        print(f"[gmail-reply] Composing reply to: {recipient}", flush=True)

        # Click Compose button
        compose_btn = page.locator('div[role="button"][gh="cm"], div:has-text("Compose")').first
        if compose_btn.is_visible():
            compose_btn.click()
        else:
            page.keyboard.press("c")  # Gmail keyboard shortcut for compose

        time.sleep(2)

        # Fill recipient
        to_input = page.locator('input[aria-label="To recipients"], input[peoplekit-id], textarea[name="to"], input[name="to"]').first
        to_input.wait_for(state="visible", timeout=10000)
        to_input.fill(recipient)
        page.keyboard.press("Enter")
        time.sleep(1)

        # Fill Subject
        subject_input = page.locator('input[name="subjectbox"], input[placeholder="Subject"]').first
        if subject_input.is_visible():
            subject_input.fill(subject)

        # Fill Body
        body_area = page.locator('div[aria-label="Message Body"], div[role="textbox"]').first
        if body_area.is_visible():
            default_body = (
                f"Hello,\n\n"
                f"Your requested Australian property rent-review reports have been successfully generated.\n"
                f"Attached are {len(report_files)} report file(s) for your review.\n\n"
                f"Kind regards,\nProperty Intelligence Automation"
            )
            body_area.fill(body_text or default_body)

        # Attach files
        file_input = page.locator('input[type="file"][name="Filedata"]').first
        if not file_input.count():
            file_input = page.locator('input[type="file"]').first

        if file_input.count():
            print(f"[gmail-reply] Attaching {len(report_files)} report file(s)...", flush=True)
            file_paths = [str(f.resolve()) for f in report_files[:10]]
            file_input.set_input_files(file_paths)
            time.sleep(4)  # Wait for upload to complete

        # Click Send
        send_btn = page.locator('div[role="button"][data-tooltip*="Send"], div:has-text("Send")').first
        if send_btn.is_visible():
            send_btn.click()
        else:
            page.keyboard.press("Control+Enter")

        time.sleep(3)
        print(f"[gmail-reply] Successfully sent email to {recipient}!", flush=True)
        return True
    except Exception as err:
        print(f"[gmail-reply] Note on web compose: {err}", file=sys.stderr, flush=True)
        return False


# ---------------------------------------------------------------------------
# Main Pipeline Orchestrator
# ---------------------------------------------------------------------------

def run_gmail_pipeline(
    *,
    browser_channel: str = "chrome",
    query: str = "has:attachment filename:csv",
    headed: bool = True,
    force: bool = False,
    max_emails: int = 5,
    timeout_seconds: float = 120.0,
) -> dict[str, Any]:
    """Execute the end-to-end Gmail Crawl -> Report Generation -> Reply pipeline with Checkpoints."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError("Playwright required: pip install -e '.[browser]'") from exc

    root_dir = Path(__file__).resolve().parents[2]
    profile_dir = root_dir / ".browser-profiles" / f"gmail-{browser_channel}"
    session_file = root_dir / ".local" / "gmail-session.json"
    download_dir = root_dir / "data" / "incoming_csv"
    download_dir.mkdir(parents=True, exist_ok=True)

    checkpoints = CheckpointManager()

    # Ensure authentication
    if not session_file.exists() and not any(profile_dir.iterdir() if profile_dir.exists() else []):
        print("[gmail-pipeline] Authenticating into Gmail...", flush=True)
        authenticate_gmail(browser_channel=browser_channel, headed=headed)

    launch_args = [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-infobars",
    ]

    summary: dict[str, Any] = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "messages_found": 0,
        "processed_batches": 0,
        "skipped_checkpoints": 0,
        "reports_generated": 0,
        "replies_sent": 0,
        "details": [],
    }

    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=str(profile_dir.resolve()),
            channel=browser_channel,
            headless=not headed,
            args=launch_args,
            ignore_default_args=["--enable-automation"],
            no_viewport=True,
        )

        page = context.pages[0] if context.pages else context.new_page()

        print("[gmail-pipeline] Opening Gmail inbox...", flush=True)
        page.goto("https://mail.google.com/mail/u/0/#inbox", wait_until="domcontentloaded", timeout=timeout_seconds * 1000)
        time.sleep(4)

        # Search in Gmail search bar
        search_box = page.locator('input[name="q"], input[aria-label*="Search"]').first
        if search_box.is_visible():
            print(f"[gmail-pipeline] Searching inbox for: {query}", flush=True)
            search_box.click()
            search_box.fill(query)
            page.keyboard.press("Enter")
            time.sleep(4)

        email_rows = page.locator('div[role="main"] tr.zA, div[role="main"] tr[role="row"]').all()
        summary["messages_found"] = len(email_rows)
        print(f"[gmail-pipeline] Found {len(email_rows)} matching thread(s).", flush=True)

        for index, row in enumerate(email_rows[:max_emails]):
            try:
                # Open thread by clicking subject or row
                subj_span = row.locator('span[data-thread-id], span.bog, div.y6, span.bqe').first
                if subj_span.is_visible():
                    subj_span.click()
                else:
                    row.click()

                time.sleep(4)
                print(f"[gmail-pipeline] Thread {index + 1} opened (URL: {page.url})", flush=True)

                # Scroll to bottom so all message cards and attachment chips render
                page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                time.sleep(2)

                subject_el = page.locator('h2[data-thread-perm-id], h2.hP').first
                subject = subject_el.inner_text().strip() if subject_el.is_visible() else "Property Batch Request"

                sender_el = page.locator('span[email], span.gD, span.zF').first
                sender = sender_el.get_attribute("email") or sender_el.inner_text() if sender_el.is_visible() else ""
                sender = sender.strip().lower()

                # Find CSV attachment
                attachment_nodes = page.locator('[download_url], span.aV3, div.a6S').all()
                csv_content = ""
                file_name = "property-batch.csv"
                save_path: Path | None = None
                ts = int(time.time())

                for node in attachment_nodes:
                    raw_url = node.get_attribute("download_url") or ""
                    node_text = node.inner_text().strip()
                    if ".csv" in (raw_url + node_text).lower():
                        if raw_url and ":" in raw_url:
                            parts = raw_url.split(":", 2)
                            if len(parts) == 3:
                                _, file_name, direct_url = parts
                                print(f"[gmail-pipeline] Fetching attachment '{file_name}' directly...", flush=True)
                                resp = context.request.get(direct_url)
                                if resp.ok:
                                    save_path = download_dir / f"{ts}-{file_name}"
                                    save_path.write_bytes(resp.body())
                                    csv_content = save_path.read_text(encoding="utf-8", errors="replace")
                                    print(f"[gmail-pipeline] Downloaded {file_name} ({len(csv_content)} chars)", flush=True)
                                    break

                # Fallback to click download if direct URL wasn't available
                if not csv_content and attachment_nodes:
                    target_chip = page.locator('span.aV3:has-text(".csv"), div.a6S:has-text(".csv")').first
                    if target_chip.is_visible():
                        file_name = target_chip.inner_text().strip() or "property-batch.csv"
                        try:
                            target_chip.hover()
                            time.sleep(1)
                            dl_btn = page.locator('div[aria-label*="Download"], div[data-tooltip*="Download"], div.aSK').first
                            click_target = dl_btn if dl_btn.is_visible() else target_chip
                            with page.expect_download(timeout=12000) as download_info:
                                click_target.click()
                            download = download_info.value
                            save_path = download_dir / f"{ts}-{download.suggested_filename}"
                            download.save_as(str(save_path))
                            csv_content = save_path.read_text(encoding="utf-8", errors="replace")
                        except Exception as dl_err:
                            print(f"[gmail-pipeline] Download click fallback notice: {dl_err}", flush=True)

                if not csv_content:
                    print(f"[gmail-pipeline] No readable CSV attachment in thread {index + 1}, returning.", flush=True)
                    page.go_back()
                    time.sleep(2)
                    continue

                print(f"[gmail-pipeline] Found CSV: {file_name} from {sender} in '{subject}'", flush=True)

                # Checkpoint validation
                ckpt_key = checkpoints.make_key(sender, subject, file_name, csv_content)
                if checkpoints.is_completed(ckpt_key) and not force:
                    print(f"[checkpoint] Skipping already completed message: {file_name} from {sender} (Key: {ckpt_key})", flush=True)
                    summary["skipped_checkpoints"] += 1
                    page.go_back()
                    time.sleep(2)
                    continue

                checkpoints.register_inbound(ckpt_key, sender, subject, file_name, csv_content)
                print(f"[pipeline] Processing new CSV batch: {file_name} (Key: {ckpt_key})", flush=True)

                # Generate reports
                batch_name = f"batch-{ts}-{re.sub(r'[^a-zA-Z0-9]', '-', sender)}"
                report_files, items = generate_reports_for_csv(
                    csv_content,
                    batch_name,
                    headed=headed,
                    saved_csv_path=save_path,
                )
                checkpoints.update_reports(ckpt_key, len(items), [str(f) for f in report_files])
                summary["reports_generated"] += len(report_files)

                # Send email reply
                reply_sent = False
                if report_files and sender:
                    reply_subj = f"Re: {subject} — Property Rent Review Reports ({len(report_files)})"
                    reply_sent = send_reply_via_playwright(page, sender, reply_subj, report_files)
                    if reply_sent:
                        checkpoints.mark_sent(ckpt_key)
                        summary["replies_sent"] += 1

                summary["processed_batches"] += 1
                summary["details"].append({
                    "sender": sender,
                    "subject": subject,
                    "file_name": file_name,
                    "reports": len(report_files),
                    "reply_sent": reply_sent,
                    "batch_dir": str(root_dir / "data" / "reports" / batch_name),
                })

                page.go_back()
                time.sleep(2)
            except Exception as batch_err:
                print(f"[gmail-pipeline] Error processing thread {index + 1}: {batch_err}", file=sys.stderr, flush=True)

        context.close()

    print(f"\n[gmail-pipeline] Run complete: {summary['processed_batches']} batch(es) processed, "
          f"{summary['skipped_checkpoints']} skipped via checkpoint, "
          f"{summary['reports_generated']} report(s) generated, {summary['replies_sent']} reply email(s) sent.", flush=True)
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="gmail-pipeline",
        description="Run end-to-end Gmail crawl -> report generation -> email reply with checkpoints.",
    )
    parser.add_argument(
        "--browser-channel",
        choices=["chrome", "msedge"],
        default="chrome",
        help="Real browser channel (default: chrome)",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Run headless without opening GUI browser",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force reprocessing even if already marked completed in checkpoints",
    )
    parser.add_argument(
        "--query",
        default="has:attachment filename:csv",
        help="Gmail search query (default: has:attachment filename:csv)",
    )
    parser.add_argument(
        "--max-emails",
        type=int,
        default=5,
        help="Maximum email threads to inspect",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=120.0,
        help="Page timeout in seconds",
    )

    args = parser.parse_args(argv)

    try:
        res = run_gmail_pipeline(
            browser_channel=args.browser_channel,
            query=args.query,
            headed=not args.headless,
            force=args.force,
            max_emails=args.max_emails,
            timeout_seconds=args.timeout,
        )
        print(json.dumps(res, indent=2))
        return 0
    except Exception as exc:
        print(f"[gmail-pipeline] Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
