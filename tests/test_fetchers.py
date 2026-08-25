import gzip
from email.message import Message
from unittest.mock import patch

from rea_pipeline.fetchers import _read_http


class _Response:
    def __init__(self, body: bytes) -> None:
        self._body = body
        self.headers = Message()
        self.headers["Content-Type"] = "text/html; charset=utf-8"
        self.headers["Content-Encoding"] = "gzip"

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        return None

    def read(self) -> bytes:
        return self._body


def test_read_http_decompresses_gzip() -> None:
    response = _Response(gzip.compress("<html>✓</html>".encode()))

    with patch("rea_pipeline.fetchers.urlopen", return_value=response):
        result = _read_http("https://example.test", 10)

    assert result == "<html>✓</html>"

