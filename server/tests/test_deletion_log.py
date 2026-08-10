import hashlib

import routes


def create_share(client, iv="aaaa", ciphertext="bbbb"):
    return client.post("/share", json={"iv": iv, "ciphertext": ciphertext})


def test_deleting_a_share_produces_a_receipt(client):
    resp = create_share(client, iv="iv1", ciphertext="cipher1")
    share_id = resp.get_json()["id"]

    resp = client.delete(f"/share/{share_id}")
    assert resp.status_code == 200
    receipt = resp.get_json()["deletionReceipt"]
    assert set(receipt.keys()) == {
        "sequence", "deletedAt", "recordIdHash", "ciphertextHash", "prevEntryHash", "entryHash",
    }
    assert receipt["sequence"] == 1
    assert receipt["prevEntryHash"] == "GENESIS"


def test_receipt_never_leaks_the_real_share_id_or_ciphertext(client):
    resp = create_share(client, iv="iv1", ciphertext="cipher1")
    share_id = resp.get_json()["id"]
    receipt = client.delete(f"/share/{share_id}").get_json()["deletionReceipt"]
    assert share_id not in str(receipt)
    assert "cipher1" not in str(receipt)
    assert "iv1" not in str(receipt)


def test_ciphertext_hash_matches_the_documented_convention(client):
    """A holder of the original iv/ciphertext (anyone who created the share) must be able to
    independently recompute this exact hash to prove which deletion is theirs — confirms the
    server actually uses sha256(iv + ciphertext), not some other hash a client couldn't predict."""
    resp = create_share(client, iv="myiv", ciphertext="myciphertext")
    share_id = resp.get_json()["id"]
    receipt = client.delete(f"/share/{share_id}").get_json()["deletionReceipt"]
    expected = hashlib.sha256(("myiv" + "myciphertext").encode("utf-8")).hexdigest()
    assert receipt["ciphertextHash"] == expected


def test_deletion_log_endpoint_returns_the_same_receipt(client):
    resp = create_share(client, iv="iv1", ciphertext="cipher1")
    share_id = resp.get_json()["id"]
    receipt = client.delete(f"/share/{share_id}").get_json()["deletionReceipt"]

    log = client.get("/deletion-log").get_json()["entries"]
    assert len(log) == 1
    assert log[0] == receipt


def test_chain_links_correctly_across_multiple_deletions(client):
    ids = [create_share(client, iv=f"iv{i}", ciphertext=f"c{i}").get_json()["id"] for i in range(3)]
    receipts = [client.delete(f"/share/{sid}").get_json()["deletionReceipt"] for sid in ids]

    assert receipts[0]["prevEntryHash"] == "GENESIS"
    assert receipts[1]["prevEntryHash"] == receipts[0]["entryHash"]
    assert receipts[2]["prevEntryHash"] == receipts[1]["entryHash"]
    assert receipts[0]["sequence"] == 1
    assert receipts[1]["sequence"] == 2
    assert receipts[2]["sequence"] == 3


def test_deleting_a_nonexistent_share_appends_nothing(client):
    resp = client.delete("/share/does-not-exist")
    assert resp.status_code == 404
    assert client.get("/deletion-log").get_json()["entries"] == []


def test_since_filters_to_later_entries_only(client):
    ids = [create_share(client, iv=f"iv{i}", ciphertext=f"c{i}").get_json()["id"] for i in range(3)]
    for sid in ids:
        client.delete(f"/share/{sid}")

    all_entries = client.get("/deletion-log").get_json()["entries"]
    assert len(all_entries) == 3

    since_first = client.get("/deletion-log?since=1").get_json()["entries"]
    assert len(since_first) == 2
    assert [e["sequence"] for e in since_first] == [2, 3]


def test_malformed_since_rejected(client):
    resp = client.get("/deletion-log?since=not-a-number")
    assert resp.status_code == 400


def test_deletion_log_requires_no_auth(client):
    """Deliberately public, same reasoning as the deploy transparency log — anyone should be able
    to independently verify the chain, not just the account that deleted something (there isn't
    one — shares are anonymous by design, see test_share.py)."""
    resp = create_share(client)
    share_id = resp.get_json()["id"]
    client.delete(f"/share/{share_id}")
    resp = client.get("/deletion-log")
    assert resp.status_code == 200
