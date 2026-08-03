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
