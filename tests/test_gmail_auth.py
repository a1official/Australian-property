import tempfile
from pathlib import Path
from rea_pipeline.gmail_auth import load_env_credentials


def test_load_env_credentials_from_file():
    with tempfile.TemporaryDirectory() as tmp_dir:
        env_file = Path(tmp_dir) / ".env"
        env_file.write_text(
            "GMAIL_USERNAME=tester@gmail.com\n"
            "GMAIL_PASSWORD=secret_password123\n",
            encoding="utf-8",
        )
        user, pwd = load_env_credentials(env_path=env_file)
        assert user == "tester@gmail.com"
        assert pwd == "secret_password123"
