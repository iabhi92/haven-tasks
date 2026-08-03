"""Sync endpoints. This blueprint never decrypts anything — it moves
{id, iv, ciphertext, updatedAt, deleted} records in and out of a bucket
scoped by bearer token, and nothing else. See docs/ARCHITECTURE.md §5.
"""

from flask import Blueprint, current_app, jsonify, request

from storage import get_keyring_bootstrap, get_records_since, put_keyring_bootstrap, upsert_records

bp = Blueprint("sync", __name__)

MAX_RECORDS_PER_PUSH = 500


def _extract_token():
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth[len("Bearer "):].strip()
    return token or None


def _valid_token_format(token):
    # A base64url-encoded 32-byte token is ~43 chars; a generous range avoids
    # rejecting valid tokens on encoding-length edge cases without accepting junk.
    return bool(token) and 20 <= len(token) <= 128


@bp.route("/sync/push", methods=["POST"])
def push():
    token = _extract_token()
    if not _valid_token_format(token):
        return jsonify({"error": "missing or invalid bearer token"}), 401

    body = request.get_json(silent=True)
    if not body or not isinstance(body.get("records"), list):
        return jsonify({"error": "body must be {records: [...]}"}), 400

    records = body["records"]
    if len(records) > MAX_RECORDS_PER_PUSH:
        return jsonify({"error": f"too many records in one push (max {MAX_RECORDS_PER_PUSH})"}), 400

    for record in records:
        if not isinstance(record, dict) or "id" not in record or "updatedAt" not in record:
            return jsonify({"error": "each record needs at least id and updatedAt"}), 400

    normalized = [
        {
            "id": r["id"],
            "iv": r.get("iv"),
            "ciphertext": r.get("ciphertext"),
            "updated_at": r["updatedAt"],
            "deleted": bool(r.get("deleted")),
        }
        for r in records
    ]

    upsert_records(current_app.config["SYNC_DB_PATH"], token, normalized)
    return jsonify({"ok": True, "count": len(normalized)})


@bp.route("/sync/pull", methods=["GET"])
def pull():
    token = _extract_token()
    if not _valid_token_format(token):
        return jsonify({"error": "missing or invalid bearer token"}), 401

    since_raw = request.args.get("since", "0")
    try:
        since = int(since_raw)
    except ValueError:
        return jsonify({"error": "since must be an integer timestamp"}), 400

    records = get_records_since(current_app.config["SYNC_DB_PATH"], token, since)
    return jsonify({"records": records})


@bp.route("/sync/keyring", methods=["POST"])
def push_keyring_bootstrap():
    """Lets the device that first enables sync publish enough for a second
    device to obtain the *same* DEK later, via the recovery code — never the
    passphrase-derived wrap, and never anything that works without the
    recovery code the server never sees. See docs/ARCHITECTURE.md §5."""
    token = _extract_token()
    if not _valid_token_format(token):
        return jsonify({"error": "missing or invalid bearer token"}), 401

    body = request.get_json(silent=True) or {}
    required = ("wrappedDekRecovery", "wrapIvRecovery", "saltRecovery", "updatedAt")
    if not all(k in body for k in required):
        return jsonify({"error": f"body must include {', '.join(required)}"}), 400

    put_keyring_bootstrap(
        current_app.config["SYNC_DB_PATH"],
        token,
        body["wrappedDekRecovery"],
        body["wrapIvRecovery"],
        body["saltRecovery"],
        body["updatedAt"],
    )
    return jsonify({"ok": True})


@bp.route("/sync/keyring", methods=["GET"])
def pull_keyring_bootstrap():
    token = _extract_token()
    if not _valid_token_format(token):
        return jsonify({"error": "missing or invalid bearer token"}), 401

    bootstrap = get_keyring_bootstrap(current_app.config["SYNC_DB_PATH"], token)
    if bootstrap is None:
        return jsonify({"error": "no keyring bootstrap published for this token yet"}), 404

    return jsonify(bootstrap)
