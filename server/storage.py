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


def init_db(db_path):
    with get_connection(db_path) as conn:
        conn.executescript(SCHEMA)


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
