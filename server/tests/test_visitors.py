import json
from unittest.mock import MagicMock, patch

import routes


def _reset_visitor_cache():
    routes._visitor_cache["value"] = None
    routes._visitor_cache["fetched_at"] = 0.0


def _fake_response(groups):
    body = json.dumps({"data": {"viewer": {"zones": [{"httpRequests1dGroups": groups}]}}}).encode()
    cm = MagicMock()
    cm.__enter__.return_value.read.return_value = body
    return cm


def test_visitors_returns_summed_requests(client, monkeypatch):
    _reset_visitor_cache()
    monkeypatch.setattr(routes, "CF_API_TOKEN", "token")
    monkeypatch.setattr(routes, "CF_ZONE_ID", "zone")
    groups = [{"sum": {"requests": 10}}, {"sum": {"requests": 5}}]
    with patch("routes.urllib.request.urlopen", return_value=_fake_response(groups)):
        resp = client.get("/api/visitors")
    assert resp.status_code == 200
    assert resp.get_json()["pageViews30d"] == 15


def test_visitors_returns_null_without_credentials(client, monkeypatch):
    _reset_visitor_cache()
    monkeypatch.setattr(routes, "CF_API_TOKEN", None)
    resp = client.get("/api/visitors")
    assert resp.status_code == 200
    assert resp.get_json()["pageViews30d"] is None


def test_visitors_caches_within_window(client, monkeypatch):
    _reset_visitor_cache()
    monkeypatch.setattr(routes, "CF_API_TOKEN", "token")
    monkeypatch.setattr(routes, "CF_ZONE_ID", "zone")
    mock_urlopen = MagicMock(return_value=_fake_response([{"sum": {"requests": 1}}]))
    with patch("routes.urllib.request.urlopen", mock_urlopen):
        client.get("/api/visitors")
        client.get("/api/visitors")
    assert mock_urlopen.call_count == 1
