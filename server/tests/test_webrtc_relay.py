import routes


def create_room(client, offer_sdp="v=0 offer stub"):
    return client.post("/webrtc-relay", json={"offerSdp": offer_sdp})


def test_create_then_get_room_round_trip(client):
    resp = create_room(client, offer_sdp="v=0 real offer")
    assert resp.status_code == 200
    body = resp.get_json()
    assert len(body["code"]) == routes.WEBRTC_CODE_LENGTH
    assert body["expiresAt"] > 0

    resp = client.get(f"/webrtc-relay/{body['code']}")
    assert resp.status_code == 200
    assert resp.get_json() == {"offerSdp": "v=0 real offer", "answerSdp": None}


def test_code_alphabet_has_no_ambiguous_characters(client):
    resp = create_room(client)
    code = resp.get_json()["code"]
    assert not any(ch in code for ch in "01OI")


def test_relay_requires_no_auth(client):
    resp = create_room(client)
    assert resp.status_code == 200


def test_get_unknown_code_returns_404(client):
    resp = client.get("/webrtc-relay/ZZZZZZZZ")
    assert resp.status_code == 404


def test_malformed_create_body_rejected(client):
    resp = client.post("/webrtc-relay", json={})
    assert resp.status_code == 400
    resp = client.post("/webrtc-relay", json={"offerSdp": ""})
    assert resp.status_code == 400
    resp = client.post("/webrtc-relay", json={"offerSdp": 123})
    assert resp.status_code == 400


def test_oversized_sdp_rejected(client):
    resp = create_room(client, offer_sdp="x" * (routes.MAX_SDP_LEN + 1))
    assert resp.status_code == 400


def test_two_rooms_get_different_codes(client):
    resp1 = create_room(client)
    resp2 = create_room(client)
    assert resp1.get_json()["code"] != resp2.get_json()["code"]


def test_lookup_is_case_insensitive(client):
    code = create_room(client).get_json()["code"]
    resp = client.get(f"/webrtc-relay/{code.lower()}")
    assert resp.status_code == 200


def test_full_offer_answer_handshake(client):
    code = create_room(client, offer_sdp="v=0 the offer").get_json()["code"]

    resp = client.post(f"/webrtc-relay/{code}/answer", json={"answerSdp": "v=0 the answer"})
    assert resp.status_code == 200
    assert resp.get_json() == {"ok": True}

    resp = client.get(f"/webrtc-relay/{code}")
    assert resp.get_json() == {"offerSdp": "v=0 the offer", "answerSdp": "v=0 the answer"}


def test_answering_unknown_code_returns_404(client):
    resp = client.post("/webrtc-relay/ZZZZZZZZ/answer", json={"answerSdp": "v=0"})
    assert resp.status_code == 404


def test_malformed_answer_body_rejected(client):
    code = create_room(client).get_json()["code"]
    resp = client.post(f"/webrtc-relay/{code}/answer", json={})
    assert resp.status_code == 400
    resp = client.post(f"/webrtc-relay/{code}/answer", json={"answerSdp": ""})
    assert resp.status_code == 400


def test_oversized_answer_rejected(client):
    code = create_room(client).get_json()["code"]
    resp = client.post(f"/webrtc-relay/{code}/answer", json={"answerSdp": "x" * (routes.MAX_SDP_LEN + 1)})
    assert resp.status_code == 400


def test_second_answer_cannot_hijack_a_claimed_room(client):
    """A guessed/observed code shouldn't let a third party overwrite the real answerer's SDP —
    only the first answer for a room is ever accepted."""
    code = create_room(client).get_json()["code"]
    first = client.post(f"/webrtc-relay/{code}/answer", json={"answerSdp": "real answer"})
    assert first.status_code == 200

    second = client.post(f"/webrtc-relay/{code}/answer", json={"answerSdp": "attacker answer"})
    assert second.status_code == 409

    resp = client.get(f"/webrtc-relay/{code}")
    assert resp.get_json()["answerSdp"] == "real answer"


def test_expired_room_is_treated_as_gone(client, monkeypatch):
    real_time = routes.time.time
    monkeypatch.setattr(routes.time, "time", lambda: real_time())

    code = create_room(client).get_json()["code"]

    future = real_time() + routes.WEBRTC_ROOM_TTL_SECONDS + 60
    monkeypatch.setattr(routes.time, "time", lambda: future)

    assert client.get(f"/webrtc-relay/{code}").status_code == 404
    assert client.post(f"/webrtc-relay/{code}/answer", json={"answerSdp": "v=0"}).status_code == 404


def test_relay_response_never_leaks_anything_beyond_sdp(client):
    code = create_room(client, offer_sdp="v=0 offer").get_json()["code"]
    client.post(f"/webrtc-relay/{code}/answer", json={"answerSdp": "v=0 answer"})
    resp = client.get(f"/webrtc-relay/{code}")
    assert set(resp.get_json().keys()) == {"offerSdp", "answerSdp"}
