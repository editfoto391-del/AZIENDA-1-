import re

import server


def test_cors_allows_managed_live_and_preview_frontend_domains():
    pattern = re.compile(server.cors_origin_regex)

    assert pattern.fullmatch("https://iqfoam-business.emergentagent.com")
    assert pattern.fullmatch("https://iqfoam-business.preview.emergentagent.com")
    assert not pattern.fullmatch("http://iqfoam-business.emergentagent.com")
    assert not pattern.fullmatch("https://unrelated.example.com")
