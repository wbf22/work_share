#!/usr/bin/env python3
"""Basic static file server for the work assignment app.

Pure standard library - no dependencies.
"""

import json
import os
import posixpath
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from mimetypes import guess_type
from urllib.parse import unquote, urlparse

HOST = "0.0.0.0"
PORT = 8082
VERSION = "0.1"
PUBLIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")


class Handler(BaseHTTPRequestHandler):
    server_version = "WorkAssign/0.1"

    def do_GET(self):
        self.serve()

    def do_HEAD(self):
        self.serve(head_only=True)

    def send_json(self, payload, status_code=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve(self, head_only=False):
        path = urlparse(self.path).path
        path = unquote(path)

        if path == "/api/health":
            self.send_json({"status": "ok", "version": VERSION})
            return

        path = posixpath.normpath(path)
        path = path.lstrip("/")
        if path in ("", "."):
            path = "index.html"

        full_path = os.path.join(PUBLIC_DIR, path)
        full_path = os.path.abspath(full_path)

        if not full_path.startswith(os.path.abspath(PUBLIC_DIR)):
            self.send_error(403, "Forbidden")
            return

        if os.path.isdir(full_path):
            full_path = os.path.join(full_path, "index.html")

        if not os.path.isfile(full_path):
            self.send_error(404, "Not found")
            return

        content_type, _ = guess_type(full_path)
        content_type = content_type or "application/octet-stream"

        with open(full_path, "rb") as f:
            body = f.read()

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))


def main():
    os.chdir(PUBLIC_DIR)
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print("Serving %s on http://localhost:%d" % (PUBLIC_DIR, PORT))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        httpd.server_close()


if __name__ == "__main__":
    main()
