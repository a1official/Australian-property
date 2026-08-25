import asyncio

from crawl4ai_paginator.cli import FetchedPage, find_next_url, paginate_pages


def page(url: str, html: str, markdown: str | None = None) -> FetchedPage:
    return FetchedPage(
        requested_url=url,
        final_url=url,
        success=True,
        status_code=200,
        title="Fixture",
        markdown=markdown or html,
        html=html,
        internal_links=[],
        external_link_count=0,
    )


def test_find_next_url_prefers_explicit_same_origin_link() -> None:
    html = '''
    <html><head><link rel="next" href="/catalog/list-2"></head>
    <body><a href="https://other.example/list-2" aria-label="Next">Next</a></body>
    </html>
    '''

    assert find_next_url("https://source.example/catalog/list-1", html) == (
        "https://source.example/catalog/list-2"
    )


def test_find_next_url_rejects_external_next_link() -> None:
    html = '<a href="https://other.example/list-2" rel="next">Next</a>'

    assert find_next_url("https://source.example/catalog/list-1", html) is None


def test_paginate_pages_follows_next_until_absent() -> None:
    fixtures = {
        "https://source.example/list-1": page(
            "https://source.example/list-1",
            '<main>One</main><a href="/list-2" rel="next">Next</a>',
        ),
        "https://source.example/list-2": page(
            "https://source.example/list-2", "<main>Two</main>"
        ),
    }

    async def fetch(url: str) -> FetchedPage:
        return fixtures[url]

    result = asyncio.run(
        paginate_pages(
            "https://source.example/list-1",
            fetch,
            max_pages=10,
            delay_seconds=0,
        )
    )

    assert result["page_count"] == 2
    assert result["stop_reason"] == "next_link_not_found"
    assert [row["page_number"] for row in result["pages"]] == [1, 2]
    assert result["pages"][0]["next_url"] == "https://source.example/list-2"


def test_paginate_pages_stops_at_safety_limit() -> None:
    async def fetch(url: str) -> FetchedPage:
        number = int(url.rsplit("-", 1)[1])
        return page(
            url,
            f'<main>{number}</main><a href="/list-{number + 1}" rel="next">Next</a>',
        )

    result = asyncio.run(
        paginate_pages(
            "https://source.example/list-1",
            fetch,
            max_pages=2,
            delay_seconds=0,
        )
    )

    assert result["page_count"] == 2
    assert result["stop_reason"] == "max_pages_reached"
