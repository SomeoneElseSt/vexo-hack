"""Demo server for the records webapp shell (webapp-shell/).

Serves the shell at / and the same sealed-record API shape as records_server.py:
the browser never receives plaintext - it fetches sealed blobs and decrypts
them with the device key (unlock.js, key via the local bridge).

For the demo the database is seeded once with fake events, sealed with this
machine's device key (my-project/.device_key, the same key local_bridge.py
hands to the browser). Exports are produced here for the demo link previews.

Run:
    python my-project/webapp_shell_server.py --port 8777
    python my-project/local_bridge.py --allow http://127.0.0.1:8777
Then open http://127.0.0.1:8777/
"""
import argparse
import base64
import json
import random
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
SHELL_DIR = HERE / "webapp-shell"

import sys  # noqa: E402
sys.path.insert(0, str(HERE))

import device_crypto as dc  # noqa: E402
import records_server as rs  # noqa: E402  (export helpers: to_fhir, to_csv, to_ips, intake_form)

DB_PATH = HERE / "data" / "shell.db"
SECRET = b""
LOCK = threading.Lock()

KINDS = ("Observation", "Encounter", "MedicationRequest")

SCHEMA = """
CREATE TABLE IF NOT EXISTS sealed_record (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  device TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ct TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
"""

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json",
}

# ---------- demo data ----------

LOCATIONS = ["chest", "head", "stomach", "lower back", "left knee", "throat"]
QUALITIES = ["pressure", "sharp pain", "dull ache", "burning", "tightness", "throbbing"]
ACTIVITIES = ["after climbing stairs", "while lying down", "after eating",
              "while walking", "at rest", "after coffee"]
DEMO_EVENTS = 42


def demo_event(rng: random.Random, when: datetime) -> dict:
    location = rng.choice(LOCATIONS)
    quality = rng.choice(QUALITIES)
    activity = rng.choice(ACTIVITIES)
    severity = rng.choice([None, 2, 3, 4, 5, 6, 7, 8])
    return {
        "id": "evt-" + when.strftime("%Y%m%d%H%M%S") + "-" + str(rng.randrange(1000, 9999)),
        "ts": when.astimezone().isoformat(timespec="seconds"),
        "body_location": location,
        "quality": quality,
        "severity": severity,
        "activity": activity,
        "verbatim_quote": f"{quality} in my {location} {activity}",
        "transcript_model": "whisper-local",
        "audio_seconds": rng.choice([3, 4, 5, 6, 8]),
    }


CLINICIANS = [("Dr. Ana Ruiz", "Cardiology"), ("Dr. Sam Okafor", "Primary Care"),
              ("Dr. Lena Weiss", "Neurology"), ("Dr. Tom Iyer", "Orthopedics")]
REASONS = ["chest tightness after exercise", "annual physical",
           "follow-up: recurring headaches", "knee pain when climbing stairs"]


def demo_visit(rng: random.Random, when: datetime, i: int) -> dict:
    name, specialty = rng.choice(CLINICIANS)
    return {
        "id": f"enc-{i:02d}",
        "ts": when.astimezone().isoformat(timespec="seconds"),
        "kind": rng.choice(["in-person", "in-person", "video"]),
        "clinician": name,
        "specialty": specialty,
        "reason": rng.choice(REASONS),
        "summary": "Discussed symptoms, examined, no red flags. Keep logging and follow up if they worsen.",
        "instructions": ["Continue logging symptoms on the band",
                          "Return if the pain gets worse or you feel faint"],
        "follow_up": (when + timedelta(days=rng.choice([14, 30, 60]))).date().isoformat(),
    }


def demo_medication(rng: random.Random, i: int) -> dict:
    return {
        "id": f"med-{i:02d}",
        "name": rng.choice(["Ibuprofen", "Metoprolol", "Sumatriptan", "Omeprazole"]),
        "dose": rng.choice(["200 mg", "25 mg", "50 mg", "20 mg"]),
        "times": rng.choice([["08:00"], ["08:00", "20:00"], ["09:00"]]),
        "instructions": "Take with food.",
        "prescribed_by": "Dr. Sam Okafor",
        "confirmed_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "confirmed_by": "patient",
    }


def seed_if_empty() -> None:
    with LOCK, db() as conn:
        # BEGIN IMMEDIATE: a second process waits here instead of seeding twice
        conn.execute("BEGIN IMMEDIATE")
        kinds = {row[0] for row in conn.execute(
            "SELECT DISTINCT kind FROM sealed_record").fetchall()}
        device = dc.device_id(SECRET)
        rng = random.Random(7)
        now = datetime.now(timezone.utc)
        count = 0
        if "Observation" not in kinds:
            for i in range(DEMO_EVENTS):
                when = now - timedelta(days=rng.uniform(0, 30), hours=rng.uniform(0, 8))
                event = demo_event(rng, when)
                sealed = dc.seal(SECRET, json.dumps(event).encode())
                conn.execute(
                    "INSERT OR REPLACE INTO sealed_record (kind, id, device, nonce, ct, received_at) "
                    "VALUES (?,?,?,?,?,?)",
                    ("Observation", event["id"], device, sealed["nonce"], sealed["ct"],
                     when.isoformat()))
                count += 1
        if "Encounter" not in kinds:
            for i in range(6):
                when = now - timedelta(days=rng.uniform(-10, 45))
                visit = demo_visit(rng, when, i)
                sealed = dc.seal(SECRET, json.dumps(visit).encode())
                conn.execute(
                    "INSERT OR REPLACE INTO sealed_record (kind, id, device, nonce, ct, received_at) "
                    "VALUES (?,?,?,?,?,?)",
                    ("Encounter", visit["id"], device, sealed["nonce"], sealed["ct"],
                     when.isoformat()))
                count += 1
        if "MedicationRequest" not in kinds:
            for i in range(3):
                med = demo_medication(rng, i)
                sealed = dc.seal(SECRET, json.dumps(med).encode())
                conn.execute(
                    "INSERT OR REPLACE INTO sealed_record (kind, id, device, nonce, ct, received_at) "
                    "VALUES (?,?,?,?,?,?)",
                    ("MedicationRequest", med["id"], device, sealed["nonce"], sealed["ct"],
                     now.isoformat()))
                count += 1
        conn.commit()
    if count:
        print(f"seeded {count} demo records into {DB_PATH}", flush=True)


# ---------- storage ----------

def db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute(SCHEMA)
    return conn


def sealed_rows(kind: str = "Observation") -> list[dict]:
    """Ciphertext only, as the browser expects: it decrypts with the device key."""
    with db() as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT id, device, nonce, ct FROM sealed_record WHERE kind=? ORDER BY received_at",
            (kind,))]
    return [{"id": r["id"], "device": r["device"], "sealed": True,
             "nonce": r["nonce"], "ct": r["ct"]} for r in rows]


def events(kind: str = "Observation") -> list[dict]:
    """Decrypted events for the server-side exports the Export view links to."""
    out = []
    for row in sealed_rows(kind):
        try:
            out.append(json.loads(dc.open_sealed(SECRET, row)))
        except ValueError:
            continue  # another device's record
    return sorted(out, key=lambda e: e.get("ts") or "")


def authorized(handler: BaseHTTPRequestHandler) -> bool:
    presented = handler.headers.get("X-Device-Auth") or ""
    expected = dc.auth_token(SECRET)
    return len(presented) == len(expected) and presented == expected


# ---------- http ----------

class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "X-Device-Auth, Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj) -> None:
        self._send(code, json.dumps(obj).encode(), "application/json")

    def _static(self, name: str) -> None:
        target = (SHELL_DIR / name).resolve()
        if not str(target).startswith(str(SHELL_DIR)) or not target.is_file():
            self._send(404, b"not found", "text/plain")
            return
        ctype = CONTENT_TYPES.get(target.suffix, "application/octet-stream")
        self._send(200, target.read_bytes(), ctype)

    def _export(self, path: str) -> None:
        ev = events()
        if path == "/export/json":
            self._json(200, ev)
            return
        if path == "/export/csv":
            self._send(200, rs.to_csv(ev).encode(), "text/csv")
            return
        if path == "/export/fhir":
            entries = []
            for e in ev:
                pair = rs.to_fhir(e)
                entries += [{"resource": pair["observation"]},
                            {"resource": pair["provenance"]}]
            self._json(200, {"resourceType": "Bundle", "type": "collection",
                             "entry": entries})
            return
        if path == "/export/ips":
            self._json(200, rs.to_ips(ev))
            return
        if path == "/api/form":
            self._json(200, rs.intake_form(ev))
            return
        self._send(404, b"not found", "text/plain")

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            self._static("index.html")
            return
        if path.startswith("/static/"):
            self._static(path[len("/static/"):])
            return
        if path == "/api/device":
            self._json(200, {"device_id": dc.device_id(SECRET)})
            return
        if path in tuple("/" + k for k in KINDS) + ("/export/json", "/export/csv",
                                                   "/export/fhir", "/export/ips", "/api/form"):
            if not authorized(self):
                self._send(401, b"device auth required", "text/plain")
                return
            if path.count("/") == 1 and path[1:] in KINDS:
                self._json(200, sealed_rows(path[1:]))
            else:
                self._export(path)
            return
        self._send(404, b"not found", "text/plain")

    def do_POST(self) -> None:
        """A new sealed record from the browser (or another device)."""
        path = urlparse(self.path).path
        kind = path[1:] if path.count("/") == 1 else ""
        if kind not in KINDS:
            self._send(404, b"not found", "text/plain")
            return
        if not authorized(self):
            self._send(401, b"device auth required", "text/plain")
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._send(400, b"bad json", "text/plain")
            return
        event = body.get("event") or {}
        sealed = body.get("sealed") or {}
        if not event.get("id") or not sealed.get("nonce") or not sealed.get("ct"):
            self._send(400, b"need event.id and sealed {nonce, ct}", "text/plain")
            return
        device = event.get("device") or dc.device_id(SECRET)
        with LOCK, db() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO sealed_record (kind, id, device, nonce, ct, received_at) "
                "VALUES (?,?,?,?,?,?)",
                (kind, event["id"], device, sealed["nonce"], sealed["ct"],
                 datetime.now(timezone.utc).isoformat()))
            conn.commit()
        self._json(201, {"id": event["id"], "kind": kind,
                         "device": device, "stored": "sealed"})

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "X-Device-Auth, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET")
        self.end_headers()

    def log_message(self, *args) -> None:
        pass


def main() -> None:
    global DB_PATH, SECRET
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8777)
    parser.add_argument("--data-dir", default=str(HERE / "data"))
    args = parser.parse_args()
    DB_PATH = Path(args.data_dir) / "shell.db"
    SECRET = dc.load_or_create_secret()
    seed_if_empty()
    print(f"shell on http://127.0.0.1:{args.port}/  (device {dc.device_id(SECRET)})")
    print(f"unlock it by also running: python my-project/local_bridge.py "
          f"--allow http://127.0.0.1:{args.port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
