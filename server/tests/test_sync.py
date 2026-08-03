import json

TOKEN_A = "a" * 43  # base64url-length-ish, arbitrary for tests
TOKEN_B = "b" * 43


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def push(client, token, records):
    return client.post("/sync/push", headers=auth(token), json={"records": records})


def pull(client, token, since=0):
    return client.get(f"/sync/pull?since={since}", headers=auth(token))


def test_push_then_pull_round_trip(client):
    record = {"id": "t1", "iv": "aaaa", "ciphertext": "bbbb", "updatedAt": 1000}
    resp = push(client, TOKEN_A, [record])
    assert resp.status_code == 200
    assert resp.get_json()["count"] == 1

    resp = pull(client, TOKEN_A, since=0)
    assert resp.status_code == 200
    records = resp.get_json()["records"]
    assert len(records) == 1
    assert records[0]["id"] == "t1"
    assert records[0]["iv"] == "aaaa"
    assert records[0]["ciphertext"] == "bbbb"
    assert records[0]["updatedAt"] == 1000
    assert records[0]["deleted"] is False


def test_missing_token_rejected(client):
    resp = client.post("/sync/push", json={"records": []})
    assert resp.status_code == 401
    resp = client.get("/sync/pull")
    assert resp.status_code == 401


def test_malformed_token_rejected(client):
    resp = push(client, "short", [])
    assert resp.status_code == 401


def test_malformed_body_rejected(client):
    resp = client.post("/sync/push", headers=auth(TOKEN_A), json={"nope": True})
    assert resp.status_code == 400

    resp = client.post("/sync/push", headers=auth(TOKEN_A), json={"records": [{"iv": "x"}]})
    assert resp.status_code == 400  # missing id/updatedAt


def test_too_many_records_rejected(client):
    records = [{"id": str(i), "iv": "x", "ciphertext": "y", "updatedAt": i} for i in range(501)]
    resp = push(client, TOKEN_A, records)
    assert resp.status_code == 400


def test_cross_token_isolation(client):
    """The self-attack checklist item from docs/THREAT_MODEL.md: can token A read
    or overwrite token B's bucket? It must not be able to, at all."""
    push(client, TOKEN_A, [{"id": "secret-task", "iv": "iv-a", "ciphertext": "cipher-a", "updatedAt": 1000}])

    resp = pull(client, TOKEN_B, since=0)
    assert resp.get_json()["records"] == []

    # token B pushing a record with the same id must not affect token A's copy
    push(client, TOKEN_B, [{"id": "secret-task", "iv": "iv-b", "ciphertext": "cipher-b", "updatedAt": 2000}])
    resp = pull(client, TOKEN_A, since=0)
    records = resp.get_json()["records"]
    assert len(records) == 1
    assert records[0]["ciphertext"] == "cipher-a"


def test_pull_since_filters_correctly(client):
    push(client, TOKEN_A, [
        {"id": "old", "iv": "x", "ciphertext": "y", "updatedAt": 1000},
        {"id": "new", "iv": "x", "ciphertext": "y", "updatedAt": 5000},
    ])
    resp = pull(client, TOKEN_A, since=2000)
    records = resp.get_json()["records"]
    assert [r["id"] for r in records] == ["new"]


def test_deletion_scrubs_ciphertext_not_just_flags_it(client):
    push(client, TOKEN_A, [{"id": "t1", "iv": "real-iv", "ciphertext": "real-ciphertext", "updatedAt": 1000}])
    push(client, TOKEN_A, [{"id": "t1", "updatedAt": 2000, "deleted": True}])

    resp = pull(client, TOKEN_A, since=0)
    records = resp.get_json()["records"]
    assert len(records) == 1
    assert records[0]["deleted"] is True
    assert records[0]["iv"] is None
    assert records[0]["ciphertext"] is None
    # the raw response body must never contain the old ciphertext bytes either
    assert "real-ciphertext" not in resp.get_data(as_text=True)


def test_last_write_wins_server_side(client):
    push(client, TOKEN_A, [{"id": "t1", "iv": "new-iv", "ciphertext": "new-cipher", "updatedAt": 5000}])
    # a stale push (older updatedAt) must not overwrite the newer stored record
    push(client, TOKEN_A, [{"id": "t1", "iv": "stale-iv", "ciphertext": "stale-cipher", "updatedAt": 1000}])

    resp = pull(client, TOKEN_A, since=0)
    records = resp.get_json()["records"]
    assert records[0]["ciphertext"] == "new-cipher"
    assert records[0]["updatedAt"] == 5000


def push_keyring(client, token, wrapped_dek_recovery="wdr", wrap_iv_recovery="wir", salt_recovery="sr", updated_at=1000):
    return client.post(
        "/sync/keyring",
        headers=auth(token),
        json={
            "wrappedDekRecovery": wrapped_dek_recovery,
            "wrapIvRecovery": wrap_iv_recovery,
            "saltRecovery": salt_recovery,
            "updatedAt": updated_at,
        },
    )


def pull_keyring(client, token):
    return client.get("/sync/keyring", headers=auth(token))


def test_keyring_bootstrap_round_trip(client):
    resp = push_keyring(client, TOKEN_A, wrapped_dek_recovery="abc", wrap_iv_recovery="def", salt_recovery="ghi")
    assert resp.status_code == 200

    resp = pull_keyring(client, TOKEN_A)
    assert resp.status_code == 200
    body = resp.get_json()
    assert body == {"wrappedDekRecovery": "abc", "wrapIvRecovery": "def", "saltRecovery": "ghi"}


def test_keyring_bootstrap_missing_returns_404(client):
    resp = pull_keyring(client, TOKEN_A)
    assert resp.status_code == 404


def test_keyring_bootstrap_cross_token_isolation(client):
    push_keyring(client, TOKEN_A, wrapped_dek_recovery="a-secret")
    resp = pull_keyring(client, TOKEN_B)
    assert resp.status_code == 404  # token B must not see token A's bootstrap material


def test_keyring_bootstrap_requires_token(client):
    resp = client.get("/sync/keyring")
    assert resp.status_code == 401
    resp = client.post("/sync/keyring", json={})
    assert resp.status_code == 401


def test_keyring_bootstrap_malformed_body_rejected(client):
    resp = client.post("/sync/keyring", headers=auth(TOKEN_A), json={"wrappedDekRecovery": "abc"})
    assert resp.status_code == 400
