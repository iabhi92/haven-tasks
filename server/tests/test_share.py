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
