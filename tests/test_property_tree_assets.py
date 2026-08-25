from source_scrapers.property_tree_assets import find_endpoint_candidates


def test_finds_endpoint_shaped_strings_but_skips_static_assets() -> None:
    source = """
    const api = "https://api.example.test/v1/properties";
    const route = "/api/tenancies";
    const login = "/connect/authorize";
    const image = "https://cdn.example.test/static/logo.svg";
    """

    results = find_endpoint_candidates(source, "app.js")
    values = {item.value for item in results}

    assert "https://api.example.test/v1/properties" in values
    assert "/api/tenancies" in values
    assert "/connect/authorize" in values
    assert "https://cdn.example.test/static/logo.svg" not in values
