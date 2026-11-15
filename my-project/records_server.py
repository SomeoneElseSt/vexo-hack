"""Records API for the self-hostable MyChart-like platform.

SQLite is the single source of truth; every standardized format is exported
from it on demand. The frontend lives in webapp/ and is served at /.

Endpoints:
    POST /Observation            store one symptom event (contract JSON)
    GET  /Observation            list events
    GET  /export/json            the raw contract events
    GET  /export/csv             timeline as CSV
    GET  /export/fhir            FHIR Bundle: Observation + Provenance per event
    GET  /export/ips             International Patient Summary-style extract
    GET  /api/form                the intake-form draft the doctor reviews
    GET  /                       the webapp (webapp/index.html if present)

Run: python3 records_server.py --port 8766 [--data-dir data]
"""
import argparse
import csv
import io
import json
import sqlite3
import gzip
import os
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import device_crypto as dc

HERE = Path(__file__).resolve().parent
WEBAPP_DIR = HERE / "webapp"

# Only codes we are sure of. Everything else stays uncoded text — never guessed.
LOINC_PAIN_SEVERITY = {"system": "http://loinc.org", "code": "72514-3",
                       "display": "Pain severity - 0-10 verbal numeric rating"}

DB_PATH = HERE / "data" / "records.db"
LOCK = threading.Lock()

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
API_LOG = os.environ.get("API_LOG", "/tmp/api.jsonl")


def log_api(method: str, path: str, status: int, note: str = "") -> None:
    line = {"t": time.strftime("%H:%M:%S"), "type": "api", "who": "server",
            "method": method, "path": path, "status": status}
    if note:
        line["note"] = note
    try:
        with open(API_LOG, "a") as fh:
            fh.write(json.dumps(line) + "\n")
    except OSError:
        pass


KINDS = ("Observation", "Encounter", "Communication", "MedicationRequest",
         "MedicationAdministration")


SECRET = None  # the device secret, loaded at startup on this machine


def db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # older DBs had a single observation table: carry it over, then drop it
    has_old = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='observation'").fetchone()
    conn.execute(SCHEMA)
    if has_old:
        conn.execute(
            "INSERT OR IGNORE INTO sealed_record (kind, id, device, nonce, ct, received_at) "
            "SELECT 'Observation', id, device, nonce, ct, received_at FROM observation")
        conn.execute("DROP TABLE observation")
        conn.commit()
    return conn


def rows(kind: str = "Observation") -> list[dict]:
    """Decrypt and verify every record of this kind with this device's key.

    In vault mode (the VM) there is no key, so only opaque blobs are returned.
    """
    with db() as conn:
        sealed_rows = [dict(r) for r in conn.execute(
            "SELECT * FROM sealed_record WHERE kind=? ORDER BY received_at", (kind,))]
    if SECRET is None:
        return [{"id": r["id"], "device": r["device"], "sealed": True,
                 "nonce": r["nonce"], "ct": r["ct"]}
                for r in sealed_rows]
    events = []
    for r in sealed_rows:
        try:
            plain = dc.open_sealed(SECRET, r)
        except ValueError:
            print("skipped record not signed by this device:", r["id"], flush=True)
            continue
        events.append(json.loads(plain))
    return sorted(events, key=lambda e: e.get("ts") or "")


def store(event: dict, sealed: dict | None, kind: str = "Observation") -> dict:
    """A record must arrive sealed by the owning device.

    Vault mode stores the ciphertext as-is and refuses plaintext: the VM can
    never read the records, only keep them for the device that can.
    """
    if kind not in KINDS:
        raise ValueError(f"unknown record kind {kind!r}")
    if SECRET is None and not sealed:
        raise ValueError("vault accepts only sealed records (no device key here)")
    event.setdefault("id", f"evt-{int(time.time() * 1000)}")
    event.setdefault("ts", datetime.now().astimezone().isoformat(timespec="seconds"))
    if sealed:
        device = event.get("device") or (dc.device_id(SECRET) if SECRET else "unknown")
    else:
        plain = json.dumps(event).encode()
        sealed = dc.seal(SECRET, plain)
        if dc.open_sealed(SECRET, sealed) != plain:
            raise ValueError("sealed record does not match its content")
        device = dc.device_id(SECRET)
    with LOCK, db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO sealed_record (kind, id, device, nonce, ct, received_at) "
            "VALUES (?,?,?,?,?,?)",
            (kind, event["id"], device, sealed["nonce"], sealed["ct"],
             datetime.now(timezone.utc).isoformat()))
    return {"id": event["id"], "kind": kind, "device": device,
            "stored": "sealed" if SECRET is None else "ok"}


def authorized(handler: BaseHTTPRequestHandler) -> bool:
    """The caller must prove it holds the device secret (vault mode: any caller
    holding the shared preview token may write sealed records, nobody may read)."""
    if SECRET is None:
        return True
    presented = handler.headers.get("X-Device-Auth") or ""
    return hmac_compare(presented, dc.auth_token(SECRET))


def hmac_compare(a: str, b: str) -> bool:
    import hmac
    return hmac.compare_digest(a.encode(), b.encode())


KIND_PATHS = tuple("/" + k for k in KINDS)


def kind_of(path: str) -> str | None:
    for kind in KINDS:
        if path == "/" + kind:
            return kind
    return None


def to_fhir(event: dict) -> dict:
    code = {"text": " ".join(x for x in [event.get("quality"), event.get("body_location")] if x)
            or "unspecified symptom"}
    obs = {
        "resourceType": "Observation",
        "id": event["id"],
        "status": "final",
        "meta": {"profile": ["http://hl7.org/fhir/StructureDefinition/Observation"]},
        "code": code,
        "effectiveDateTime": event.get("ts"),
        "subject": {"reference": "Patient/demo-patient"},
        "device": {"display": "Vexo-HACK-29 band"},
        "note": [{"text": event.get("verbatim_quote") or ""}],
    }
    if event.get("body_location"):
        obs["bodySite"] = {"text": event["body_location"]}
    if event.get("severity") is not None:
        obs["component"] = [{
            "code": {"coding": [LOINC_PAIN_SEVERITY], "text": "severity 0-10"},
            "valueInteger": event["severity"],
        }]
    prov = {
        "resourceType": "Provenance",
        "id": f"prov-{event['id']}",
        "recorded": event.get("ts"),
        "target": [{"reference": f"Observation/{event['id']}"}],
        "agent": [{"who": {"display": event.get("extract_model") or "local model"}}],
        "entity": [{"role": "source",
                    "what": {"display": f"band audio, {event.get('audio_seconds') or 0}s, "
                                       f"transcribed by {event.get('transcript_model') or 'local'}"}}],
    }
    return {"observation": obs, "provenance": prov}


def to_ips(events: list[dict]) -> dict:
    latest = events[-1] if events else {}
    return {
        "resourceType": "Bundle",
        "type": "document",
        "meta": {"profile": ["http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips"]},
        "entry": [
            {"resource": {"resourceType": "Patient", "id": "demo-patient"}},
            {"resource": {
                "resourceType": "Composition",
                "title": "Patient Symptom Summary",
                "section": [
                    {"title": "Problem list",
                     "text": {"status": "generated",
                              "div": f"<div>{latest.get('quality') or ''} "
                                     f"{latest.get('body_location') or ''}</div>"}},
                    {"title": "History of present illness",
                     "text": {"status": "generated",
                              "div": f"<div>{latest.get('verbatim_quote') or ''}</div>"}},
                    {"title": "Events in this summary", "entry_count": len(events)},
                ],
            }},
        ] + [{"resource": to_fhir(e)["observation"]} for e in events],
    }


def to_csv(events: list[dict]) -> str:
    out = io.StringIO()
    cols = ["id", "ts", "body_location", "quality", "severity", "activity", "verbatim_quote"]
    w = csv.DictWriter(out, fieldnames=cols, extrasaction="ignore")
    w.writeheader()
    for e in events:
        w.writerow(e)
    return out.getvalue()


def intake_form(events: list[dict]) -> dict:
    """The doctor's draft: use the event that carries the most clinical signal."""
    if not events:
        return {"chief_complaint": None, "hpi": None, "severity": None,
                "event_count": 0, "source": "band · local models"}
    def score(e: dict) -> tuple:
        return (e.get("severity") is not None, bool(e.get("body_location")),
                bool(e.get("activity")), e.get("ts") or "")
    main_event = max(events, key=score)
    return {
        "chief_complaint": " ".join(x for x in [main_event.get("quality"),
                                                main_event.get("body_location")] if x) or None,
        "hpi": main_event.get("verbatim_quote"),
        "severity": main_event.get("severity"),
        "activity": main_event.get("activity"),
        "event_count": len(events),
        "source": "band · local models",
    }


PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>Patient intake</title>
<style>body{font:15px/1.5 -apple-system,sans-serif;margin:2rem;max-width:60rem}
.ev{border-left:3px solid #3b82f6;padding:.35rem .8rem;margin:.45rem 0;background:#f7f9fc}</style>
</head><body><h1>Symptom intake</h1><div id="timeline"></div>
<script>async function load(){const ev=await(await fetch('/Observation')).json();
document.getElementById('timeline').innerHTML=ev.map(e=>`<div class="ev"><b>${e.ts}</b> —
${e.body_location||''} <div>${e.verbatim_quote||''}</div></div>`).join('')||'No events yet.'}
load();setInterval(load,5000)</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: bytes, ctype: str,
              cache: str = "no-store") -> None:
        path = self.path.split("?")[0]
        if path not in ("/", "/index.html"):
            log_api(self.command, path, code)
        accepts_gzip = "gzip" in (self.headers.get("Accept-Encoding") or "")
        compressible = ctype.startswith(("text/", "application/json",
                                        "application/javascript", "image/svg"))
        if accepts_gzip and compressible and len(body) > 512:
            body = gzip.compress(body, 6)
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", cache)
        if accepts_gzip and compressible:
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj) -> None:
        self._send(code, json.dumps(obj, indent=1).encode(), "application/json")

    def do_GET(self) -> None:
        path = self.path.split("?")[0]
        index = WEBAPP_DIR / "index.html"
        if path in ("/", "/index.html"):
            # the dashboard shell is public: it holds no patient data by itself
            if index.exists():
                self._send(200, index.read_bytes(), "text/html; charset=utf-8")
            else:
                self._send(200, PAGE.encode(), "text/html; charset=utf-8")
            return
        if not path.startswith(KIND_PATHS + ("/api/", "/export/")):
            self._static(path)
            return
        if not authorized(self):
            self._send(401, b"device auth required", "text/plain")
            return
        kind = kind_of(path)
        if kind and path.count("/") == 1:
            self._json(200, rows(kind))
            return
        events = rows()
        if path == "/export/json":
            self._json(200, events)
            return
        if path == "/export/csv":
            self._send(200, to_csv(events).encode(), "text/csv")
            return
        if path == "/export/fhir":
            entries = []
            for e in events:
                pair = to_fhir(e)
                entries += [{"resource": pair["observation"]},
                            {"resource": pair["provenance"]}]
            for kind, resource_type in (("Encounter", "Encounter"),
                                        ("Communication", "Communication"),
                                        ("MedicationRequest", "MedicationRequest"),
                                        ("MedicationAdministration", "MedicationAdministration")):
                for rec in rows(kind):
                    res = {"resourceType": resource_type, "id": rec.get("id"),
                           "meta": {"profile": ["http://hl7.org/fhir/StructureDefinition/"
                                                + resource_type]}}
                    for key in ("ts", "clinician", "specialty", "kind", "reason",
                                "summary", "instructions", "follow_up", "thread",
                                "from", "to", "sender", "body", "priority", "action",
                                "name", "dose", "times", "prescribed_by", "visit_id",
                                "start", "end", "confirmed_at", "confirmed_by",
                                "medication_ids", "related_event_ids", "medication_id",
                                "medication_name", "dose_taken", "taken_at", "method"):
                        if key in rec:
                            res[key if key != "ts" else "effectiveDateTime"] = rec[key]
                    entries.append({"resource": res})
            self._json(200, {"resourceType": "Bundle", "type": "collection",
                             "entry": entries})
            return
        if path == "/export/ips":
            self._json(200, to_ips(events))
            return
        if path == "/api/form":
            self._json(200, intake_form(events))
            return
        if path == "/api/device":
            # lets the browser check a key before asking for the records
            self._json(200, {"device_id": dc.device_id(SECRET)})
            return
        self._send(404, b"not found", "text/plain")

    def _static(self, path: str) -> None:
        if not WEBAPP_DIR.exists():
            self._send(404, b"not found", "text/plain")
            return
        target = (WEBAPP_DIR / path.lstrip("/")).resolve()
        if not str(target).startswith(str(WEBAPP_DIR)) or not target.is_file():
            self._send(404, b"not found", "text/plain")
            return
        ctype = {"css": "text/css", "js": "application/javascript",
                 "html": "text/html; charset=utf-8", "svg": "image/svg+xml",
                 "png": "image/png"}.get(target.suffix.lstrip("."),
                                         "application/octet-stream")
        self._send(200, target.read_bytes(), ctype, cache="public, max-age=60")

    def do_POST(self) -> None:
        path = self.path.split("?")[0]
        kind = kind_of(path) if path.count("/") == 1 else None
        if not kind:
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
        # two shapes: a plain event (sealed here) or {event, sealed} from another device
        event = body.get("event", body)
        sealed = body.get("sealed")
        try:
            stored = store(event, sealed, kind)
        except ValueError as exc:
            self._send(403, str(exc).encode(), "text/plain")
            return
        print("stored", kind, stored.get("id"), flush=True)
        self._json(201, stored)

    def log_message(self, *args) -> None:
        pass


def main() -> None:
    global DB_PATH, SECRET
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--data-dir", default=str(HERE / "data"))
    parser.add_argument("--vault", action="store_true",
                        help="no device key: store sealed blobs, never decrypt")
    args = parser.parse_args()
    DB_PATH = Path(args.data_dir) / "records.db"
    if args.vault:
        SECRET = None
        print(f"records VAULT on http://0.0.0.0:{args.port}/ (sqlite {DB_PATH})")
        print("no device key here: records are stored sealed and cannot be read "
              "on this machine", flush=True)
    else:
        SECRET = dc.load_or_create_secret()
        print(f"records server on http://0.0.0.0:{args.port}/ (sqlite {DB_PATH})")
        print(f"device id: {dc.device_id(SECRET)} — key in {dc.KEY_FILE}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
