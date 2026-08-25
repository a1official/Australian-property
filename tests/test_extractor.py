import json

from rea_pipeline.extractor import extract_argonaut_from_html, extract_rental_search


def sample_exchange() -> dict:
    payload = {
        "rentSearch": {
            "resolvedQuery": {"localities": ["Sydney, NSW 2000"]},
            "results": {
                "totalResultsCount": 448,
                "exact": {"items": [{"listing": {"id": "437123456"}}]},
                "pagination": {
                    "page": 1,
                    "maxPageNumberAvailable": 18,
                    "moreResultsAvailable": True,
                },
            },
        }
    }
    cache = {"query-key": {"data": json.dumps(payload)}}
    return {
        "resi-property_listing-experience-web": {
            "urqlClientCache": json.dumps(cache)
        }
    }


def test_extracts_json_assignment_and_rent_search() -> None:
    expected = sample_exchange()
    html = (
        "<html><script>window.other = 1;</script><script>\n"
        f"window.ArgonautExchange = {json.dumps(expected)};\n"
        "</script></html>"
    )

    exchange = extract_argonaut_from_html(html)
    batch = extract_rental_search(exchange)

    assert exchange == expected
    assert batch.listings == [{"id": "437123456"}]
    assert batch.total_results == 448
    assert batch.page == 1
    assert batch.max_page == 18
    assert batch.more_results is True

