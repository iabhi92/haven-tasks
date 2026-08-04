import os

from flask import Flask

from routes import bp
from storage import init_db


def create_app(db_path=None):
    app = Flask(__name__)
    app.config["SYNC_DB_PATH"] = db_path or os.environ.get("SYNC_DB_PATH", "sync.db")
    init_db(app.config["SYNC_DB_PATH"])
    app.register_blueprint(bp)

    @app.after_request
    def add_cors_headers(response):
        # The frontend is a static site that can be hosted on any origin, and this
        # sync server is meant to be deployed separately from it — the bearer token,
        # not the request origin, is what actually scopes access to a bucket (see
        # docs/ARCHITECTURE.md §5), so a permissive CORS policy here doesn't weaken
        # anything an attacker couldn't already do by calling the API directly.
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
        # This is a JSON API with no HTML/script responses of its own, so the
        # tightest possible baseline applies regardless of what the frontend's
        # own CSP says — defense in depth if this API is ever hit directly.
        response.headers["Content-Security-Policy"] = "default-src 'none'"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    return app


if __name__ == "__main__":
    create_app().run(port=5000, debug=True)
