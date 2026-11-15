"""Watch the demo live: what the band hears, how it is labelled, and every API call.

Usage (another terminal, while the bridge and records server run):
    .venv/bin/python my-project/watch.py
    .venv/bin/python my-project/watch.py --vm https://<vm-preview-host>?superserve_preview_token=...

It tails the bridge log for heard/labelled lines and polls the records API for
new records of every kind, printing one line per record as it lands.
"""

import argparse
import json
import sys
import time
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import device_crypto as dc  # noqa: E402

KINDS = ["Observation", "Encounter", "MedicationRequest",
         "MedicationAdministration", "Communication"]


def auth() -> str:
    return dc.auth_token(dc.load_or_create_secret())


def snapshot(base: str, token: str) -> dict:
    """{kind: [ids]} — what the records API holds right now."""
    state = {}
    for kind in KINDS:
        try:
            r = requests.get(f"{base}/{kind}", timeout=10,
                             headers={"X-Device-Auth": token})
            r.raise_for_status()
            rows = r.json()
            state[kind] = [row.get("id") for row in rows if isinstance(row, dict)]
        except Exception:
            state[kind] = []
    return state


def records_by_id(base: str, token: str, kind: str, wanted: list) -> list:
    try:
        r = requests.get(f"{base}/{kind}", timeout=10, headers={"X-Device-Auth": token})
        r.raise_for_status()
        rows = {row.get("id"): row for row in r.json() if isinstance(row, dict)}
    except Exception:
        return []
    return [rows[i] for i in wanted if i in rows]


def describe(kind: str, rec: dict) -> str:
    if kind == "Observation":
        return (f"{rec.get('quality') or '?'} in {rec.get('body_location') or '?'} "
                f"sev={rec.get('severity')} :: {(rec.get('verbatim_quote') or '')[:60]!r} "
                f"[{rec.get('extract_model') or 'no model'}]")
    if kind == "MedicationAdministration":
        return (f"dose TAKEN {rec.get('medication_name') or '?'} "
                f"({rec.get('dose_taken') or '?'}) method={rec.get('method')} "
                f"at {rec.get('taken_at')} :: {(rec.get('verbatim_quote') or '')[:50]!r}")
    if kind == "MedicationRequest":
        return f"medicine {rec.get('name')} {rec.get('dose')} times={rec.get('times')}"
    if kind == "Encounter":
        return f"visit with {rec.get('clinician')} :: {(rec.get('summary') or '')[:60]!r}"
    return json.dumps(rec)[:120]


def tail_bridge(log_path: Path, seen_lines: int) -> int:
    """Print new 'heard ...' / 'gate ...' lines; return the new line count."""
    if not log_path.exists():
        return seen_lines
    lines = log_path.read_text(errors="replace").splitlines()
    for line in lines[seen_lines:]:
        if line.startswith(("heard ", "gate ", "pushed ", "dose logged", "extract failed")):
            print(f"  band  {line}", flush=True)
    return len(lines)


def follow(path: Path, offset: int) -> int:
    """Print new lines of a file as they appear; return the new offset."""
    if not path.exists():
        return offset
    with path.open(errors="replace") as fh:
        fh.seek(offset)
        for line in fh:
            print(f"  {line.rstrip()}", flush=True)
        return fh.tell()


def raw_mode(stream_log: Path, api_log: Path) -> None:
    """The literal stream: every transcript, gate label, route and API call."""
    print(f"raw firehose\n  bridge stream: {stream_log}\n  server api:    {api_log}\n")
    s_off, a_off = 0, 0
    if stream_log.exists():
        s_off = stream_log.stat().st_size
        print(f"  (skipping {s_off} bytes already in the stream)\n")
    if api_log.exists():
        a_off = api_log.stat().st_size
    try:
        while True:
            s_off = follow(stream_log, s_off)
            a_off = follow(api_log, a_off)
            time.sleep(0.3)
    except KeyboardInterrupt:
        print("\nstopped")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--records", default="http://localhost:8766")
    parser.add_argument("--bridge-log", default="/tmp/bridge.log")
    parser.add_argument("--interval", type=float, default=1.0)
    parser.add_argument("--raw", action="store_true",
                        help="literal firehose: every transcript, label, route and API line")
    parser.add_argument("--stream-log", default="/tmp/stream.jsonl")
    parser.add_argument("--api-log", default="/tmp/api.jsonl")
    args = parser.parse_args()

    if args.raw:
        return raw_mode(Path(args.stream_log), Path(args.api_log))

    token = auth()
    base = args.records.split("?")[0] if "superserve" in args.records else args.records
    print(f"watching {base} as device {dc.device_id(dc.load_or_create_secret())}", flush=True)
    print("  band   = what the band heard and how it was labelled\n"
          "  API    = a record that landed in the records API\n", flush=True)

    known = snapshot(base, token)
    print("existing records:", {k: len(v) for k, v in known.items() if v}, flush=True)
    log_path = Path(args.bridge_log)
    lines = len(log_path.read_text(errors="replace").splitlines()) if log_path.exists() else 0
    try:
        while True:
            time.sleep(args.interval)
            lines = tail_bridge(log_path, lines)
            now = snapshot(base, token)
            for kind in KINDS:
                fresh = [i for i in now[kind] if i not in known.get(kind, [])]
                if not fresh:
                    continue
                for rec in records_by_id(base, token, kind, fresh):
                    print(f"  API   POST /{kind:<24} {describe(kind, rec)}", flush=True)
                known[kind] = now[kind]
    except KeyboardInterrupt:
        print("\nstopped", flush=True)


if __name__ == "__main__":
    main()
