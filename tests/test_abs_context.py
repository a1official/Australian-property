from __future__ import annotations

from rea_pipeline.abs_context import get_abs_market_context


QUICKSTATS_HTML = """
<html>
  <head><title>2021 2000, NSW, Census All persons QuickStats | ABS</title></head>
  <body>
    <script id="data" type="application/json">
      {"cycle":"2021","geographyTypeCode":"POA","geographyAreaCode":"POA2000"}
    </script>
    <table class="summaryTable qsPeople">
      <tr><th>People</th><td>27,936</td></tr>
      <tr><th>Median age</th><td>32</td></tr>
    </table>
    <table class="summaryTable qsDwelling">
      <tr><th>All private dwellings</th><td>16,534</td></tr>
      <tr><th>Average number of people per household</th><td>2.1</td></tr>
      <tr><th>Median weekly household income</th><td>$2,225</td></tr>
      <tr><th>Median monthly mortgage repayments</th><td>$2,800</td></tr>
      <tr><th>Median weekly rent (b)</th><td>$625</td></tr>
    </table>
  </body>
</html>
"""


def test_abs_context_normalizes_quickstats_and_seifa() -> None:
    def fetch_text(url: str, timeout: float) -> str:
        assert url.endswith("/POA2000")
        assert timeout == 5
        return QUICKSTATS_HTML

    def fetch_json(url: str, timeout: float) -> dict:
        assert "poa_code_2021" in url
        assert timeout == 5
        return {
            "features": [
                {
                    "attributes": {
                        "irsad_score": 1106.97,
                        "irsad_aus_decile": 10,
                        "irsad_aus_percentile": 93,
                        "irsd_score": 973.06,
                        "irsd_aus_decile": 4,
                        "irsd_aus_percentile": 33,
                    }
                }
            ]
        }

    context = get_abs_market_context(
        "2000",
        timeout_seconds=5,
        fetch_text=fetch_text,
        fetch_json=fetch_json,
        use_cache=False,
    )

    assert context["area_name"] == "2000, NSW"
    assert context["population"] == 27_936
    assert context["median_age_years"] == 32.0
    assert context["median_weekly_household_income"] == 2_225
    assert context["median_monthly_mortgage_repayment"] == 2_800
    assert context["median_weekly_rent"] == 625
    assert context["irsad_decile"] == 10


def test_abs_context_remains_available_when_seifa_is_down() -> None:
    def failed_json(_: str, __: float) -> dict:
        raise OSError("offline")

    context = get_abs_market_context(
        "2000",
        fetch_text=lambda _url, _timeout: QUICKSTATS_HTML,
        fetch_json=failed_json,
        use_cache=False,
    )

    assert context["population"] == 27_936
    assert context["irsad_decile"] is None
