"""Sync endpoints. This blueprint never decrypts anything — it moves
{id, iv, ciphertext, updatedAt, deleted} records in and out of a bucket
scoped by bearer token, and nothing else. See docs/ARCHITECTURE.md §5.
"""

import json
import os
import secrets
import time
import urllib.error
import urllib.request

from flask import Blueprint, current_app, jsonify, request

from storage import (
    create_share,
    delete_share,
    get_deletion_log,
    get_keyring_bootstrap,
    get_records_since,
    get_share,
    put_keyring_bootstrap,
    upsert_records,
)

bp = Blueprint("sync", __name__)

MAX_RECORDS_PER_PUSH = 500

# Shares are anonymous (no bearer token) by design — the random id is the
# only credential. These caps keep that from becoming free anonymous
# storage: small payloads only, and gone again within a bounded time.
MAX_SHARE_FIELD_LEN = 20_000
SHARE_TTL_SECONDS = 7 * 24 * 60 * 60  # default when ttlSeconds is omitted

# Capability links (docs/ARCHITECTURE.md): sender can choose a shorter or
# longer lifetime than the default, and/or a view-count limit for
# burn-after-reading. Both are clamped server-side so the client's choice
# can't be used to create either a near-permanent share or a storage-abuse
# vector of many-thousands-of-views rows.
MIN_SHARE_TTL_SECONDS = 60
MAX_SHARE_TTL_SECONDS = 30 * 24 * 60 * 60
MIN_SHARE_MAX_VIEWS = 1
MAX_SHARE_MAX_VIEWS = 1000

# Visitor-count badge for the portfolio (iabhi92.online) to fetch cross-origin. This backend
# already has no persistent worker/cron on Render's free tier (see docs/ARCHITECTURE.md), so
# caching on read — like the crackrsa status endpoint does — is the only way to avoid re-querying
# Cloudflare's API on every portfolio page load. ponytail: single-process in-memory cache, resets
# on a Render cold start; fine for a vanity counter, upgrade to a real store if that ever matters.
CF_API_TOKEN = os.environ.get("CF_API_TOKEN")
CF_ZONE_ID = os.environ.get("CF_ZONE_ID")
VISITOR_CACHE_SECONDS = 3600
VISITOR_WINDOW_DAYS = 30
_visitor_cache = {"value": None, "fetched_at": 0.0}

_VISITOR_QUERY = """
query ($zoneTag: String!, $since: Date!, $until: Date!) {
  viewer {
    zones(filter: {zoneTag: $zoneTag}) {
      httpRequests1dGroups(limit: 31, filter: {date_geq: $since, date_leq: $until}) {
        sum { requests }
      }
    }
  }
}
"""


def _fetch_visitor_count():
    now = time.time()
    if _visitor_cache["value"] is not None and now - _visitor_cache["fetched_at"] < VISITOR_CACHE_SECONDS:
        return _visitor_cache["value"]
    if not CF_API_TOKEN or not CF_ZONE_ID:
        return None

    since = time.strftime("%Y-%m-%d", time.gmtime(now - VISITOR_WINDOW_DAYS * 86400))
    until = time.strftime("%Y-%m-%d", time.gmtime(now))
    body = json.dumps({
        "query": _VISITOR_QUERY,
        "variables": {"zoneTag": CF_ZONE_ID, "since": since, "until": until},
    }).encode()
    req = urllib.request.Request(
        "https://api.cloudflare.com/client/v4/graphql",
        data=body,
        headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=6) as resp:
            data = json.loads(resp.read())
        groups = data["data"]["viewer"]["zones"][0]["httpRequests1dGroups"]
        total = sum(g["sum"]["requests"] for g in groups)
    except (urllib.error.URLError, KeyError, IndexError, TypeError, ValueError):
        return None

    _visitor_cache["value"] = total
    _visitor_cache["fetched_at"] = now
    return total


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


@bp.route("/share", methods=["POST"])
def create_share_route():
    """Deliberately unauthenticated: a share link's security comes entirely
    from the fragment key never reaching this server (see
    docs/ARCHITECTURE.md "Fragment-key share links"), not from a bearer
    token. The share id is generated here, not client-supplied, so it always
    has full server-side-verified entropy."""
    body = request.get_json(silent=True) or {}
    iv = body.get("iv")
    ciphertext = body.get("ciphertext")
    if not isinstance(iv, str) or not isinstance(ciphertext, str) or not iv or not ciphertext:
        return jsonify({"error": "body must include non-empty iv and ciphertext strings"}), 400
    if len(iv) > MAX_SHARE_FIELD_LEN or len(ciphertext) > MAX_SHARE_FIELD_LEN:
        return jsonify({"error": "iv/ciphertext too large"}), 400

    ttl_seconds = body.get("ttlSeconds", SHARE_TTL_SECONDS)
    if not isinstance(ttl_seconds, int) or isinstance(ttl_seconds, bool):
        return jsonify({"error": "ttlSeconds must be an integer number of seconds"}), 400
    if not (MIN_SHARE_TTL_SECONDS <= ttl_seconds <= MAX_SHARE_TTL_SECONDS):
        return jsonify({
            "error": f"ttlSeconds must be between {MIN_SHARE_TTL_SECONDS} and {MAX_SHARE_TTL_SECONDS}"
        }), 400

    max_views = body.get("maxViews")
    if max_views is not None:
        if not isinstance(max_views, int) or isinstance(max_views, bool):
            return jsonify({"error": "maxViews must be an integer or omitted"}), 400
        if not (MIN_SHARE_MAX_VIEWS <= max_views <= MAX_SHARE_MAX_VIEWS):
            return jsonify({
                "error": f"maxViews must be between {MIN_SHARE_MAX_VIEWS} and {MAX_SHARE_MAX_VIEWS}"
            }), 400

    share_id = secrets.token_urlsafe(24)
    now = int(time.time() * 1000)
    expires_at = now + ttl_seconds * 1000

    create_share(current_app.config["SYNC_DB_PATH"], share_id, iv, ciphertext, now, expires_at, max_views)
    return jsonify({"id": share_id, "expiresAt": expires_at})


@bp.route("/share/<share_id>", methods=["GET"])
def get_share_route(share_id):
    now = int(time.time() * 1000)
    share = get_share(current_app.config["SYNC_DB_PATH"], share_id, now)
    if share is None:
        return jsonify({"error": "share not found or expired"}), 404
    return jsonify(share)


@bp.route("/share/<share_id>", methods=["DELETE"])
def delete_share_route(share_id):
    """Revocation. See delete_share's docstring for why no auth is required
    here beyond already knowing the id. Returns a deletion-log receipt
    (docs/ARCHITECTURE.md "Cryptographic proof of deletion") the caller can
    verify anytime against GET /deletion-log, independent of trusting this
    response itself."""
    now = int(time.time() * 1000)
    receipt = delete_share(current_app.config["SYNC_DB_PATH"], share_id, now)
    if receipt is None:
        return jsonify({"error": "share not found"}), 404
    return jsonify({"ok": True, "deletionReceipt": receipt})


@bp.route("/deletion-log", methods=["GET"])
def deletion_log_route():
    """Public, unauthenticated on purpose — same reasoning as the client-side
    deploy transparency log (docs/ARCHITECTURE.md §5d-2): the whole point is
    that anyone, not just the person who deleted something, can independently
    verify the chain is internally consistent. Never reveals a real share id
    or its content, only hashes of each — see the deletion_log schema comment
    in storage.py for what that does and doesn't prove."""
    since_raw = request.args.get("since", "0")
    try:
        since = int(since_raw)
    except ValueError:
        return jsonify({"error": "since must be an integer sequence number"}), 400
    return jsonify({"entries": get_deletion_log(current_app.config["SYNC_DB_PATH"], since)})


@bp.route("/api/visitors", methods=["GET"])
def visitors():
    return jsonify({"pageViews30d": _fetch_visitor_count()})
