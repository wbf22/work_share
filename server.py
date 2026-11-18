#!/usr/bin/env python3
"""Basic server for the work assignment app.

Pure standard library - no dependencies.

Serves the static frontend from ./public, a small JSON API for work items,
and image files stored under ./data/images. Work items are persisted as JSON
in ./data/work.json.
"""

import base64
import json
import os
import posixpath
import re
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from mimetypes import guess_type
from urllib.parse import unquote, urlparse

HOST = "0.0.0.0"
PORT = 8082
VERSION = "0.4"

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
DATA_DIR = os.path.join(BASE_DIR, "data")
IMAGES_DIR = os.path.join(DATA_DIR, "images")
WORK_FILE = os.path.join(DATA_DIR, "work.json")
WORKERS_FILE = os.path.join(DATA_DIR, "workers.json")
GROUPS_FILE = os.path.join(DATA_DIR, "groups.json")
QUALIFICATIONS_FILE = os.path.join(DATA_DIR, "qualifications.json")

MAX_IMAGE_BYTES = 10 * 1024 * 1024
IMAGE_TYPES = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
}

_lock = threading.Lock()


# --------------------------------------------------------------------------
# Storage helpers
# --------------------------------------------------------------------------

def ensure_dirs():
    os.makedirs(IMAGES_DIR, exist_ok=True)


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_json(path, default):
    if not os.path.isfile(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def load_work():
    return read_json(WORK_FILE, [])


def save_work(items):
    write_json(WORK_FILE, items)


def load_groups():
    groups = read_json(GROUPS_FILE, [])
    if not isinstance(groups, list):
        return []
    return [g for g in groups if isinstance(g, dict) and clean_text(g.get("name"))]


def sync_groups(items):
    """Rebuild groups.json from the work items.

    Each group is {name, work: [work ids], createdAt, updatedAt}. Groups that
    no longer have any work items disappear, and the work list is refreshed on
    every save.
    """
    previous = {clean_text(g["name"]): g for g in load_groups()}
    groups = {}
    for item in items:
        name = clean_text(item.get("group"))
        if not name:
            continue
        if name not in groups:
            prior = previous.get(name, {})
            groups[name] = {
                "name": name,
                "work": [],
                "createdAt": prior.get("createdAt") or now_iso(),
                "updatedAt": now_iso(),
            }
        groups[name]["work"].append(item.get("id"))

    ordered = [groups[name] for name in sorted(groups, key=str.lower)]
    write_json(GROUPS_FILE, ordered)
    return ordered


def load_qualifications():
    quals = read_json(QUALIFICATIONS_FILE, [])
    if not isinstance(quals, list):
        return []
    return [q for q in quals if isinstance(q, dict) and clean_text(q.get("name"))]


def sync_qualifications(items):
    """Rebuild qualifications.json from the work items.

    Each qualification is {name, work: [work ids], createdAt, updatedAt}.
    Mirrors sync_groups: created on use, updated on change, dropped when its
    last work item is removed.
    """
    previous = {clean_text(q["name"]): q for q in load_qualifications()}
    quals = {}
    for item in items:
        for raw in item.get("qualifications") or []:
            name = clean_text(raw)
            if not name:
                continue
            if name not in quals:
                prior = previous.get(name, {})
                quals[name] = {
                    "name": name,
                    "work": [],
                    "createdAt": prior.get("createdAt") or now_iso(),
                    "updatedAt": now_iso(),
                }
            if item.get("id") not in quals[name]["work"]:
                quals[name]["work"].append(item.get("id"))

    ordered = [quals[name] for name in sorted(quals, key=str.lower)]
    write_json(QUALIFICATIONS_FILE, ordered)
    return ordered


def clean_int(value, low, high, default):
    try:
        number = int(round(float(value)))
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


def clean_bool(value, default=False):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    if isinstance(value, (int, float)):
        return bool(value)
    return default


def clean_text(value, default=""):
    if value is None:
        return default
    return str(value).strip()


def clean_qualifications(value):
    if isinstance(value, list):
        items = value
    elif isinstance(value, str):
        items = value.split(",")
    else:
        return []
    seen = []
    for item in items:
        text = clean_text(item)
        if text and text not in seen:
            seen.append(text)
    return seen


def clean_images(value):
    if not isinstance(value, list):
        return []
    return [clean_text(v) for v in value if clean_text(v)]


def build_work(payload, base=None):
    base = base or {}
    return {
        "id": base.get("id") or uuid.uuid4().hex[:12],
        "name": clean_text(payload.get("name", base.get("name")), "") or "Untitled work",
        "group": clean_text(payload.get("group", base.get("group"))),
        "description": clean_text(payload.get("description", base.get("description"))),
        "qualifications": clean_qualifications(
            payload.get("qualifications", base.get("qualifications", []))
        ),
        "physicalDemand": clean_int(
            payload.get("physicalDemand", base.get("physicalDemand")), 0, 10, 5
        ),
        "progress": clean_int(payload.get("progress", base.get("progress")), 0, 100, 0),
        "autoAssign": clean_bool(payload.get("autoAssign", base.get("autoAssign")), True),
        "reassignEachMeeting": clean_bool(
            payload.get("reassignEachMeeting", base.get("reassignEachMeeting")), False
        ),
        "images": clean_images(payload.get("images", base.get("images", []))),
        "assignedTo": clean_text(payload.get("assignedTo", base.get("assignedTo"))) or None,
        "createdAt": base.get("createdAt") or now_iso(),
        "updatedAt": now_iso(),
    }


def find_work(items, work_id):
    for item in items:
        if item.get("id") == work_id:
            return item
    return None


def save_image(payload):
    data_url = clean_text(payload.get("data"))
    match = re.match(r"data:(image/[a-z0-9.+-]+);base64,(.*)$", data_url, re.S)
    if not match:
        raise ValueError("Expected a base64 image data URL")

    mime = match.group(1).lower()
    ext = IMAGE_TYPES.get(mime)
    if not ext:
        raise ValueError("Unsupported image type: %s" % mime)

    try:
        raw = base64.b64decode(match.group(2), validate=True)
    except (ValueError, TypeError):
        raise ValueError("Invalid base64 image data")

    if not raw:
        raise ValueError("Empty image")
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("Image is too large (max 10 MB)")

    ensure_dirs()
    filename = "%s.%s" % (uuid.uuid4().hex, ext)
    with open(os.path.join(IMAGES_DIR, filename), "wb") as f:
        f.write(raw)
    return "/images/" + filename


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------

WORK_ID_RE = re.compile(r"^/api/work/([^/]+)$")
WORK_DUP_RE = re.compile(r"^/api/work/([^/]+)/duplicate$")


class Handler(BaseHTTPRequestHandler):
    server_version = "WorkAssign/" + VERSION

    # ---- response helpers -------------------------------------------------

    def send_json(self, payload, status_code=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self):
        length = clean_int(self.headers.get("Content-Length"), 0, 50 * 1024 * 1024, 0)
        if not length:
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    def serve_file(self, full_path, head_only=False):
        if os.path.isdir(full_path):
            full_path = os.path.join(full_path, "index.html")
        if not os.path.isfile(full_path):
            self.send_error(404, "Not found")
            return
        content_type, _ = guess_type(full_path)
        with open(full_path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def safe_join(self, base, path):
        full = os.path.abspath(os.path.join(base, path))
        if not full.startswith(os.path.abspath(base)):
            return None
        return full

    # ---- routing ----------------------------------------------------------

    def do_GET(self):
        self.route("GET")

    def do_HEAD(self):
        self.route("HEAD")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")

    def route(self, method):
        path = unquote(urlparse(self.path).path)
        try:
            if self.handle_api(method, path):
                return
            if method in ("GET", "HEAD"):
                self.serve_static(path, head_only=(method == "HEAD"))
            else:
                self.send_error(404, "Not found")
        except Exception as exc:  # keep the server alive on unexpected errors
            self.send_json({"error": str(exc)}, 500)

    def handle_api(self, method, path):
        if path == "/api/health" and method in ("GET", "HEAD"):
            self.send_json({"status": "ok", "version": VERSION})
            return True

        if path == "/api/work" and method == "GET":
            with _lock:
                self.send_json(load_work())
            return True

        if path == "/api/workers" and method == "GET":
            with _lock:
                self.send_json(read_json(WORKERS_FILE, []))
            return True

        if path == "/api/groups" and method == "GET":
            with _lock:
                self.send_json(load_groups())
            return True

        if path == "/api/qualifications" and method == "GET":
            with _lock:
                self.send_json(load_qualifications())
            return True

        if path == "/api/work" and method == "POST":
            payload = self.read_json_body()
            if not isinstance(payload, dict):
                self.send_json({"error": "Invalid JSON body"}, 400)
                return True
            with _lock:
                items = load_work()
                item = build_work(payload)
                items.append(item)
                save_work(items)
                sync_groups(items)
                sync_qualifications(items)
            self.send_json(item, 201)
            return True

        if path == "/api/images" and method == "POST":
            payload = self.read_json_body()
            if not isinstance(payload, dict):
                self.send_json({"error": "Invalid JSON body"}, 400)
                return True
            try:
                url = save_image(payload)
            except ValueError as exc:
                self.send_json({"error": str(exc)}, 400)
                return True
            self.send_json({"url": url}, 201)
            return True

        match = WORK_DUP_RE.match(path)
        if match and method == "POST":
            work_id = match.group(1)
            with _lock:
                items = load_work()
                source = find_work(items, work_id)
                if not source:
                    self.send_json({"error": "Work not found"}, 404)
                    return True
                copy = dict(source)
                copy["id"] = uuid.uuid4().hex[:12]
                copy["name"] = source.get("name", "Work") + " (copy)"
                copy["createdAt"] = now_iso()
                copy["updatedAt"] = now_iso()
                items.append(copy)
                save_work(items)
                sync_groups(items)
                sync_qualifications(items)
            self.send_json(copy, 201)
            return True

        match = WORK_ID_RE.match(path)
        if match:
            work_id = match.group(1)
            if method == "PUT":
                payload = self.read_json_body()
                if not isinstance(payload, dict):
                    self.send_json({"error": "Invalid JSON body"}, 400)
                    return True
                with _lock:
                    items = load_work()
                    existing = find_work(items, work_id)
                    if not existing:
                        self.send_json({"error": "Work not found"}, 404)
                        return True
                    updated = build_work(payload, base=existing)
                    items[items.index(existing)] = updated
                    save_work(items)
                    sync_groups(items)
                    sync_qualifications(items)
                self.send_json(updated)
                return True
            if method == "DELETE":
                with _lock:
                    items = load_work()
                    existing = find_work(items, work_id)
                    if not existing:
                        self.send_json({"error": "Work not found"}, 404)
                        return True
                    items.remove(existing)
                    save_work(items)
                    sync_groups(items)
                    sync_qualifications(items)
                self.send_json({"ok": True})
                return True

        return False

    # ---- static files -----------------------------------------------------

    def serve_static(self, path, head_only=False):
        if path.startswith("/images/"):
            name = path[len("/images/"):]
            full = self.safe_join(IMAGES_DIR, name)
            if full is None:
                self.send_error(403, "Forbidden")
                return
            self.serve_file(full, head_only=head_only)
            return

        norm = posixpath.normpath(path).lstrip("/")
        if norm in ("", "."):
            norm = "index.html"
        full = self.safe_join(PUBLIC_DIR, norm)
        if full is None:
            self.send_error(403, "Forbidden")
            return
        self.serve_file(full, head_only=head_only)

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))


def main():
    ensure_dirs()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print("Serving %s on http://localhost:%d" % (PUBLIC_DIR, PORT))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        httpd.server_close()


if __name__ == "__main__":
    main()
