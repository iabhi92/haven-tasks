# Haven sync server

A dumb encrypted-blob store. It never decrypts anything, never sees a passphrase, and never sees a
recovery code — see [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) §5 for the protocol and
[`docs/THREAT_MODEL.md`](../docs/THREAT_MODEL.md) for what it does and doesn't protect against.

Completely optional. The frontend works fully offline without this ever being deployed.

## Run it locally

```
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 app.py
```

Serves on `http://localhost:5000` by default. Point Haven's "Sync settings" (⌘K → Sync settings)
at that URL.

`SYNC_DB_PATH` (env var) controls where the SQLite file lives; defaults to `sync.db` in this
directory.

## Test

```
python3 -m pytest tests/ -v
```

## Deploy

Any host that runs a Python/WSGI app works — this is a plain Flask app, `gunicorn` is in
`requirements.txt` for production use (the `python3 app.py` dev server explicitly warns against
production use; don't ship that path).

Example (Render): a Python web service pointed at this `server/` directory, with:
- Build command: `pip install -r requirements.txt`
- Start command: `gunicorn -w 2 -b 0.0.0.0:$PORT "app:create_app()"`

**Honest limitation:** on a free-tier host without a persistent disk (e.g. Render's free plan),
the SQLite file (`SYNC_DB_PATH`, `sync.db` by default) lives on ephemeral storage — it is wiped on
every redeploy and, on some hosts, on every restart/spin-down. This is fine for trying sync out,
but it means **the sync bucket is not durable** on a free tier. For real durability, either attach
a persistent disk (a paid tier on most hosts) or point `SYNC_DB_PATH` at a managed database volume.
This is a hosting-layer limitation, not a code limitation — the storage layer (`storage.py`) is
plain SQLite and doesn't care where the file lives.
