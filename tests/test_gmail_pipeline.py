import tempfile
from pathlib import Path
from rea_pipeline.gmail_pipeline import CheckpointManager, parse_australian_address, generate_reports_for_csv


def test_checkpoint_manager_lifecycle():
    with tempfile.TemporaryDirectory() as tmp_dir:
        ckpt_path = Path(tmp_dir) / "checkpoints.json"
        mgr = CheckpointManager(checkpoint_path=ckpt_path)

        key = mgr.make_key("client@example.com", "Monthly Review", "batch.csv", "addr1\naddr2")
        assert not mgr.is_completed(key)

        mgr.register_inbound(key, "client@example.com", "Monthly Review", "batch.csv", "addr1\naddr2")
        mgr.update_reports(key, 2, ["rep1.html", "rep2.html"])
        mgr.mark_sent(key)

        assert mgr.is_completed(key)

        # Reload from disk
        mgr2 = CheckpointManager(checkpoint_path=ckpt_path)
        assert mgr2.is_completed(key)
        assert mgr2.records[key].sender == "client@example.com"
        assert len(mgr2.records[key].report_files) == 2


def test_parse_australian_address():
    parsed1 = parse_australian_address("10 Example Street, Sydney NSW 2000")
    assert parsed1["state"] == "NSW"
    assert parsed1["postcode"] == "2000"
    assert "Sydney" in parsed1["suburb"]

    parsed2 = parse_australian_address("2 Albert Avenue Broadbeach QLD 4218")
    assert parsed2["state"] == "QLD"
    assert parsed2["postcode"] == "4218"
    assert "Broadbeach" in parsed2["suburb"]


def test_generate_reports_for_csv():
    with tempfile.TemporaryDirectory() as tmp_dir:
        sample_csv = 'address,property_id\n"10 Example Street, Sydney NSW 2000",PROP-001\n'
        db_path = Path("data/realstate.db")
        reports, summary = generate_reports_for_csv(sample_csv, "test-batch", database_path=db_path)
        assert len(reports) >= 1
        assert any("PROP-001" in str(r) for r in reports)
