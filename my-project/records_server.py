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
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEBAPP_DIR = HERE / "webapp"

# Only codes we are sure of. Everything else stays uncoded text — never guessed.
LOINC_PAIN_SEVERITY = {"system": "http://loinc.org", "code": "72514-3",
                       "display": "Pain severity - 0-10 verbal numeric rating"}

DB_PATH = HERE / "data" / "records.db"
LOCK = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS observation (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  source TEXT,
  audio_seconds REAL,
  body_location TEXT,
  quality TEXT,
  severity INTEGER,
  activity TEXT,
  verbatim_quote TEXT,
  transcript_model TEXT,
  extract_model TEXT,
  schema_version TEXT,
  received_at TEXT NOT NULL
);
"""


def db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute(SCHEMA)
    return conn


def rows() -> list[dict]:
    with db() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM observation ORDER BY ts")]


def store(event: dict) -> dict:
    event.setdefault("id", f"evt-{int(time.time() * 1000)}")
    event.setdefault("ts", datetime.now().astimezone().isoformat(timespec="seconds"))
    fields = ["id", "ts", "source", "audio_seconds", "body_location", "quality",
              "severity", "activity", "verbatim_quote", "transcript_model",
              "extract_model", "schema_version"]
    values = [event.get(f) for f in fields] + [datetime.now(timezone.utc).isoformat()]
    placeholders = ",".join("?" * (len(fields) + 1))
    with LOCK, db() as conn:
        conn.execute(
            f"INSERT OR REPLACE INTO observation ({','.join(fields)}, received_at) "
            f"VALUES ({placeholders})", values)
    return event


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
    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj) -> None:
        self._send(code, json.dumps(obj, indent=1).encode(), "application/json")

    def do_GET(self) -> None:
        path = self.path.split("?")[0]
        if path == "/Observation":
            self._json(200, rows())
            return
        if path == "/export/json":
            self._json(200, rows())
            return
        if path == "/export/csv":
            self._send(200, to_csv(rows()).encode(), "text/csv")
            return
        if path == "/export/fhir":
            events = rows()
            entries = []
            for e in events:
                pair = to_fhir(e)
                entries += [{"resource": pair["observation"]},
                            {"resource": pair["provenance"]}]
            self._json(200, {"resourceType": "Bundle", "type": "collection",
                             "entry": entries})
            return
        if path == "/export/ips":
            self._json(200, to_ips(rows()))
            return
        if path == "/api/form":
            self._json(200, intake_form(rows()))
            return
        if path in ("/", "/index.html"):
            index = WEBAPP_DIR / "index.html"
            if index.exists():
                self._send(200, index.read_bytes(), "text/html; charset=utf-8")
            else:
                self._send(200, PAGE.encode(), "text/html; charset=utf-8")
            return
        if WEBAPP_DIR.exists():
            target = (WEBAPP_DIR / path.lstrip("/")).resolve()
            if str(target).startswith(str(WEBAPP_DIR)) and target.is_file():
                ctype = {"css": "text/css", "js": "application/javascript",
                         "html": "text/html; charset=utf-8",
                         "svg": "image/svg+xml", "png": "image/png"}.get(
                    target.suffix.lstrip("."), "application/octet-stream")
                self._send(200, target.read_bytes(), ctype)
                return
        self._send(404, b"not found", "text/plain")

    def do_POST(self) -> None:
        path = self.path.split("?")[0]
        if path != "/Observation":
            self._send(404, b"not found", "text/plain")
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            event = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._send(400, b"bad json", "text/plain")
            return
        stored = store(event)
        print("stored", stored.get("id"), (stored.get("verbatim_quote") or "")[:60], flush=True)
        self._json(201, stored)

    def log_message(self, *args) -> None:
        pass


def main() -> None:
    global DB_PATH
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--data-dir", default=str(HERE / "data"))
    args = parser.parse_args()
    DB_PATH = Path(args.data_dir) / "records.db"
    print(f"records server on http://0.0.0.0:{args.port}/ (sqlite {DB_PATH})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
