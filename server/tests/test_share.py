import routes


def create_share(client, iv="aaaa", ciphertext="bbbb"):
    return client.post("/share", json={"iv": iv, "ciphertext": ciphertext})


def test_create_then_get_share_round_trip(client):
    resp = create_share(client, iv="iv1", ciphertext="cipher1")
    assert resp.status_code == 200
    body = resp.get_json()
    assert "id" in body and len(body["id"]) > 20
    assert body["expiresAt"] > 0

    resp = client.get(f"/share/{body['id']}")
    assert resp.status_code == 200
    assert resp.get_json() == {"iv": "iv1", "ciphertext": "cipher1"}


def test_share_requires_no_auth(client):
    """Unlike /sync/*, /share is deliberately unauthenticated — the id itself
    is the capability. Confirm no Authorization header is needed either way."""
    resp = create_share(client)
    assert resp.status_code == 200


def test_get_unknown_share_returns_404(client):
    resp = client.get("/share/does-not-exist")
    assert resp.status_code == 404


def test_malformed_body_rejected(client):
    resp = client.post("/share", json={"iv": "x"})
    assert resp.status_code == 400
    resp = client.post("/share", json={})
    assert resp.status_code == 400
    resp = client.post("/share", json={"iv": "", "ciphertext": ""})
    assert resp.status_code == 400


def test_oversized_payload_rejected(client):
    resp = create_share(client, ciphertext="x" * (routes.MAX_SHARE_FIELD_LEN + 1))
    assert resp.status_code == 400


def test_two_shares_get_different_ids(client):
    resp1 = create_share(client)
    resp2 = create_share(client)
    assert resp1.get_json()["id"] != resp2.get_json()["id"]


def test_expired_share_is_treated_as_gone(client, monkeypatch):
    real_time = routes.time.time
    monkeypatch.setattr(routes.time, "time", lambda: real_time())

    resp = create_share(client, iv="iv1", ciphertext="cipher1")
    share_id = resp.get_json()["id"]

    # jump the clock forward past the TTL for the GET only
    future = real_time() + routes.SHARE_TTL_SECONDS + 3600
    monkeypatch.setattr(routes.time, "time", lambda: future)

    resp = client.get(f"/share/{share_id}")
    assert resp.status_code == 404


def test_share_response_never_leaks_a_key(client):
    """Self-attack check mirroring docs/THREAT_MODEL.md style: the fragment
    key is generated client-side and never sent to this server at all, so it
    can never appear in a stored share's response body."""
    resp = create_share(client, iv="iv1", ciphertext="cipher1")
    share_id = resp.get_json()["id"]
    resp = client.get(f"/share/{share_id}")
    body = resp.get_json()
    assert set(body.keys()) == {"iv", "ciphertext"}


# ---------- capability links: custom TTL, max views, revocation ----------

def test_custom_ttl_is_honored(client, monkeypatch):
    real_time = routes.time.time
    monkeypatch.setattr(routes.time, "time", lambda: real_time())

    resp = client.post("/share", json={"iv": "a", "ciphertext": "b", "ttlSeconds": 120})
    share_id = resp.get_json()["id"]

    monkeypatch.setattr(routes.time, "time", lambda: real_time() + 60)
    assert client.get(f"/share/{share_id}").status_code == 200

    monkeypatch.setattr(routes.time, "time", lambda: real_time() + 121)
    assert client.get(f"/share/{share_id}").status_code == 404


def test_ttl_out_of_range_rejected(client):
    resp = client.post("/share", json={"iv": "a", "ciphertext": "b", "ttlSeconds": 10})
    assert resp.status_code == 400
    resp = client.post("/share", json={"iv": "a", "ciphertext": "b", "ttlSeconds": routes.MAX_SHARE_TTL_SECONDS + 1})
    assert resp.status_code == 400
    resp = client.post("/share", json={"iv": "a", "ciphertext": "b", "ttlSeconds": "not-a-number"})
    assert resp.status_code == 400
    resp = client.post("/share", json={"iv": "a", "ciphertext": "b", "ttlSeconds": True})
    assert resp.status_code == 400


def test_max_views_out_of_range_rejected(client):
    resp = client.post("/share", json={"iv": "a", "ciphertext": "b", "maxViews": 0})
    assert resp.status_code == 400
    resp = client.post("/share", json={"iv": "a", "ciphertext": "b", "maxViews": routes.MAX_SHARE_MAX_VIEWS + 1})
    assert resp.status_code == 400


def test_burn_after_reading_expires_after_one_view(client):
    resp = create_share(client, iv="once", ciphertext="only")
    share_id = resp.get_json()["id"]
    # this share had no maxViews set, so re-fetching it repeatedly must keep working —
    # sanity check before testing the maxViews=1 case below.
    assert client.get(f"/share/{share_id}").status_code == 200
    assert client.get(f"/share/{share_id}").status_code == 200

    resp = client.post("/share", json={"iv": "burn", "ciphertext": "afterreading", "maxViews": 1})
    burn_id = resp.get_json()["id"]
    first = client.get(f"/share/{burn_id}")
    assert first.status_code == 200
    assert first.get_json() == {"iv": "burn", "ciphertext": "afterreading"}

    second = client.get(f"/share/{burn_id}")
    assert second.status_code == 404


def test_max_views_n_allows_exactly_n_views(client):
    resp = client.post("/share", json={"iv": "a", "ciphertext": "b", "maxViews": 3})
    share_id = resp.get_json()["id"]
    assert client.get(f"/share/{share_id}").status_code == 200
    assert client.get(f"/share/{share_id}").status_code == 200
    assert client.get(f"/share/{share_id}").status_code == 200
    assert client.get(f"/share/{share_id}").status_code == 404


def test_revoke_makes_share_immediately_unavailable(client):
    resp = create_share(client, iv="secret", ciphertext="stuff")
    share_id = resp.get_json()["id"]
    assert client.get(f"/share/{share_id}").status_code == 200

    resp = client.delete(f"/share/{share_id}")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["ok"] is True
    assert "deletionReceipt" in body

    assert client.get(f"/share/{share_id}").status_code == 404


def test_revoke_unknown_share_returns_404(client):
    resp = client.delete("/share/does-not-exist")
    assert resp.status_code == 404


def test_revoke_is_idempotent_second_call_404s(client):
    resp = create_share(client)
    share_id = resp.get_json()["id"]
    assert client.delete(f"/share/{share_id}").status_code == 200
    assert client.delete(f"/share/{share_id}").status_code == 404
