"""SQLite-backed storage for the sync blob store.

This module never inspects or decrypts a record's contents — it only ever
touches `iv`/`ciphertext` as opaque strings. See docs/ARCHITECTURE.md §5.
"""

import sqlite3
from contextlib import contextmanager

SCHEMA = """
CREATE TABLE IF NOT EXISTS records (
    token TEXT NOT NULL,
    id TEXT NOT NULL,
    iv TEXT,
    ciphertext TEXT,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (token, id)
);

-- Lets a second device obtain the *same* DEK as the device that first enabled
-- sync, via the recovery-code mechanism (docs/ARCHITECTURE.md §4) repurposed
-- for this — the recovery code is a secret that never touches the server, so
-- this row is exactly as useless without it as the local keyring's own
-- wrappedDekRecovery already is. Never contains task content of any kind.
CREATE TABLE IF NOT EXISTS keyring_bootstrap (
    token TEXT PRIMARY KEY,
    wrapped_dek_recovery TEXT NOT NULL,
    wrap_iv_recovery TEXT NOT NULL,
    salt_recovery TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- A share is opaque ciphertext keyed only by an unguessable random id (see
-- docs/ARCHITECTURE.md "Fragment-key share links"). There is no bearer token
-- here on purpose: the id itself is the capability, generated with the same
-- entropy as a recovery code, and the decryption key never reaches this
-- table or this server at all — it lives only in the recipient's URL
-- fragment. expires_at enforces the share's lifetime; rows past it are
-- treated as absent and reaped opportunistically. max_views/views_used
-- implement optional burn-after-reading (docs/ARCHITECTURE.md "Capability
-- links"): max_views NULL means unlimited views until expiry.
CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY,
    iv TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    max_views INTEGER,
    views_used INTEGER NOT NULL DEFAULT 0
)
"""


@contextmanager
def get_connection(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _add_column_if_missing(conn, table, column, coldef):
    existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {coldef}")


def init_db(db_path):
    with get_connection(db_path) as conn:
        conn.executescript(SCHEMA)
        # Migration for databases created before capability links (max_views/
        # views_used) existed — CREATE TABLE IF NOT EXISTS above is a no-op
        # against an already-existing `shares` table, so new columns need an
        # explicit, idempotent ALTER TABLE here instead.
        _add_column_if_missing(conn, "shares", "max_views", "INTEGER")
        _add_column_if_missing(conn, "shares", "views_used", "INTEGER NOT NULL DEFAULT 0")


def upsert_records(db_path, token, records):
    """Upsert records into a token's bucket. Last-write-wins by updated_at,
    enforced here too (not just client-side) so a stale push can't clobber a
    newer record already stored. A deleted record has its iv/ciphertext
    scrubbed immediately — the tombstone (id + updated_at + deleted) is all
    that's kept, per BUILD_BRIEF.md's "a real delete path, not just a flag".
    """
    with get_connection(db_path) as conn:
        for record in records:
            deleted = bool(record.get("deleted"))
            iv = None if deleted else record.get("iv")
            ciphertext = None if deleted else record.get("ciphertext")
            conn.execute(
                """
                INSERT INTO records (token, id, iv, ciphertext, updated_at, deleted)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(token, id) DO UPDATE SET
                    iv = excluded.iv,
                    ciphertext = excluded.ciphertext,
                    updated_at = excluded.updated_at,
                    deleted = excluded.deleted
                WHERE excluded.updated_at >= records.updated_at
                """,
                (token, record["id"], iv, ciphertext, record["updated_at"], int(deleted)),
            )


def put_keyring_bootstrap(db_path, token, wrapped_dek_recovery, wrap_iv_recovery, salt_recovery, updated_at):
    with get_connection(db_path) as conn:
        conn.execute(
            """
            INSERT INTO keyring_bootstrap (token, wrapped_dek_recovery, wrap_iv_recovery, salt_recovery, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(token) DO UPDATE SET
                wrapped_dek_recovery = excluded.wrapped_dek_recovery,
                wrap_iv_recovery = excluded.wrap_iv_recovery,
                salt_recovery = excluded.salt_recovery,
                updated_at = excluded.updated_at
            """,
            (token, wrapped_dek_recovery, wrap_iv_recovery, salt_recovery, updated_at),
        )


def get_keyring_bootstrap(db_path, token):
    with get_connection(db_path) as conn:
        row = conn.execute(
            "SELECT wrapped_dek_recovery, wrap_iv_recovery, salt_recovery FROM keyring_bootstrap WHERE token = ?",
            (token,),
        ).fetchone()
        if row is None:
            return None
        return {
            "wrappedDekRecovery": row["wrapped_dek_recovery"],
            "wrapIvRecovery": row["wrap_iv_recovery"],
            "saltRecovery": row["salt_recovery"],
        }


def create_share(db_path, share_id, iv, ciphertext, created_at, expires_at, max_views=None):
    """Store one opaque share. share_id must already be caller-generated with
    enough entropy to be unguessable (it's the only access control here).
    max_views=None means unlimited views until expires_at."""
    with get_connection(db_path) as conn:
        conn.execute(
            "INSERT INTO shares (id, iv, ciphertext, created_at, expires_at, max_views) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (share_id, iv, ciphertext, created_at, expires_at, max_views),
        )


def get_share(db_path, share_id, now):
    """Fetch-and-consume-a-view in one atomic statement: a view only counts if
    the share still exists, hasn't expired, and hasn't hit max_views yet. This
    has to be a single UPDATE...RETURNING (not a separate SELECT then UPDATE)
    so two near-simultaneous requests against a max_views=1 burn-after-reading
    share can't both read the row as "not yet used" and both see the
    plaintext — the WHERE clause is re-checked atomically per row by SQLite.
    Returns None if missing, expired, or already exhausted."""
    with get_connection(db_path) as conn:
        row = conn.execute(
            """
            UPDATE shares SET views_used = views_used + 1
            WHERE id = ? AND expires_at > ? AND (max_views IS NULL OR views_used < max_views)
            RETURNING iv, ciphertext
            """,
            (share_id, now),
        ).fetchone()
        if row is None:
            return None
        return {"iv": row["iv"], "ciphertext": row["ciphertext"]}


def delete_share(db_path, share_id):
    """Revocation: the id is the only credential this system has, so whoever
    holds it (sender or recipient) is already trusted to the same degree a
    GET would trust them — deleting it early is not a stronger capability
    than reading it. Returns True if a row was actually deleted."""
    with get_connection(db_path) as conn:
        cur = conn.execute("DELETE FROM shares WHERE id = ?", (share_id,))
        return cur.rowcount > 0


def delete_expired_shares(db_path, now):
    with get_connection(db_path) as conn:
        conn.execute("DELETE FROM shares WHERE expires_at <= ?", (now,))


def get_records_since(db_path, token, since):
    """Records in this token's bucket changed after `since` — scoped strictly
    to `token`, so a different token can never see or affect this bucket."""
    with get_connection(db_path) as conn:
        rows = conn.execute(
            "SELECT id, iv, ciphertext, updated_at, deleted FROM records "
            "WHERE token = ? AND updated_at > ? ORDER BY updated_at ASC",
            (token, since),
        ).fetchall()
        return [
            {
                "id": row["id"],
                "iv": row["iv"],
                "ciphertext": row["ciphertext"],
                "updatedAt": row["updated_at"],
                "deleted": bool(row["deleted"]),
            }
            for row in rows
        ]
