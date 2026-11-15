"""Live demo logger in the aie-hack style: one line per decision, then a roster.

Every line is a single decision the system made, in the form
    <what> -> <decision>  (<why>)
and at the end a roster summary is written to my-project/data/roster.json:

    {"history": [{"type": "gate", "kind": "symptom", "decision": "log",
                  "pass_rate": 0.83, "by_intent": {...}, "avg_seconds": 0.79,
                  "at": "..."}],
     "totals": {"transcripts": 12, "logged": 4, "dropped": 8, "api_calls": 9}}

Usage:
    .venv/bin/python my-project/watch.py               # follow the live streams
    .venv/bin/python my-project/watch.py --summary     # print the roster only
"""

import argparse
import json
import time
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROSTER = HERE / "data" / "roster.json"
STREAM_LOG = Path("/tmp/stream.jsonl")
API_LOG = Path("/tmp/api.jsonl")

INTENTS = ("symptom", "dose", "message", "visit", "other")
ROUTE = {"symptom": "/Observation", "dose": "/MedicationAdministration",
         "message": "/Communication", "visit": "/Communication"}


def load_roster() -> dict:
    if ROSTER.exists():
        return json.loads(ROSTER.read_text())
    return {"history": [], "totals": Counter()}


def save_roster(roster: dict, totals: Counter) -> None:
    ROSTER.parent.mkdir(parents=True, exist_ok=True)
    data = {"history": roster["history"][-200:], "totals": dict(totals)}
    ROSTER.write_text(json.dumps(data, indent=1))


def line_gate(entry: dict) -> str:
    kind = entry.get("kind") or "other"
    decision = "log" if entry.get("log") else "drop"
    target = ROUTE.get(kind, "nothing") if entry.get("log") else "nothing"
    why = entry.get("reason") or ""
    return (f"gate  {decision:<4} {kind:<8} -> {target:<26} "
            f"{entry.get('text', '')[:44]!r} ({why[:50]})")


def line_transcript(entry: dict) -> str:
    return (f"heard {entry.get('audio_s')}s rms={entry.get('rms')} -> "
            f"{(entry.get('text') or '')[:70]!r}")


def line_route(entry: dict) -> str:
    return (f"route {entry.get('intent'):<8} -> {entry.get('path'):<26} "
            f"{entry.get('text', '')[:44]!r}")


def line_api(entry: dict) -> str:
    who = entry.get("who") or "bridge"
    note = f" {entry['id']}" if entry.get("id") else ""
    return (f"api   {entry.get('method', 'GET'):<4} {entry.get('path'):<26} "
            f"{entry.get('status')}{note}  ({who})")


def line_model(entry: dict) -> str:
    ok = "ok" if entry.get("ok") else f"FAILED {entry.get('error', '')[:40]}"
    return (f"model {entry.get('role'):<8} {entry.get('model'):<12} "
            f"{entry.get('seconds')}s attempt={entry.get('attempt', 1)} {ok} "
            f"{entry.get('text', '')[:34]!r}")


def line_band_event(entry: dict) -> str:
    return f"band  event {entry.get('event'):<10} {entry.get('detail', '')}"


def line_utterance(entry: dict) -> str:
    return f"voc   utterance {entry.get('audio_s')}s ({entry.get('speech_ms')} ms speech)"


def line_vad(entry: dict) -> str:
    return (f"vad   rms={entry.get('rms'):<5} floor={entry.get('floor'):<4} "
            f"thr={entry.get('threshold'):<4} speech={entry.get('speech')}")


def line_vad_drop(entry: dict) -> str:
    return f"voc   dropped {entry.get('reason')} ({entry.get('audio_s')}s)"


def line_generic(entry: dict) -> str:
    fields = {k: v for k, v in entry.items() if k not in ("t", "type")}
    text = ", ".join(f"{k}={v}" for k, v in fields.items())
    return f"{entry.get('type'):<10} {text[:90]}"


RENDER = {"gate": line_gate, "transcript": line_transcript,
          "route": line_route, "api": line_api, "model": line_model,
          "band_event": line_band_event, "utterance": line_utterance,
          "vad": line_vad, "vad_drop": line_vad_drop}


def read_entries(stream_log: Path, api_log: Path) -> list[dict]:
    entries = []
    for path in (stream_log, api_log):
        if not path.exists():
            continue
        for raw in path.read_text(errors="replace").splitlines():
            try:
                entries.append(json.loads(raw))
            except json.JSONDecodeError:
                continue
    return entries


def summary(stream_log: Path, api_log: Path) -> None:
    """The roster: how the decisions came out, per intent."""
    entries = read_entries(stream_log, api_log)
    gates = [e for e in entries if e.get("type") == "gate"]
    logged = [g for g in gates if g.get("log")]
    by_intent = Counter(g.get("kind") or "other" for g in logged)
    transcripts = [e for e in entries if e.get("type") == "transcript"]
    api_calls = [e for e in entries if e.get("type") == "api"]
    pass_rate = round(len(logged) / len(gates), 3) if gates else 0.0

    roster = load_roster()
    roster["history"].append({
        "type": "gate", "kind": "all", "decision": "live",
        "pass_rate": pass_rate,
        "by_intent": {i: by_intent.get(i, 0) for i in INTENTS if by_intent.get(i)},
        "avg_seconds": 0.0,
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
    })
    totals = Counter(roster.get("totals") or {})
    totals.update({"transcripts": len(transcripts), "logged": len(logged),
                   "dropped": len(gates) - len(logged), "api_calls": len(api_calls)})
    save_roster(roster, totals)
    print(f"gate: {len(gates)} decisions, {len(logged)} logged ({pass_rate:.0%}) "
          f"{dict(by_intent)}")
    print(f"band: {len(transcripts)} transcripts | api: {len(api_calls)} calls")
    print(f"roster written to {ROSTER}")


def follow(path: Path, offset: int) -> int:
    if not path.exists():
        return offset
    with path.open(errors="replace") as fh:
        fh.seek(offset)
        for raw in fh:
            try:
                entry = json.loads(raw)
            except json.JSONDecodeError:
                continue
            render = RENDER.get(entry.get("type")) or line_generic
            print("  " + render(entry), flush=True)
        return fh.tell()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stream-log", default=str(STREAM_LOG))
    parser.add_argument("--api-log", default=str(API_LOG))
    parser.add_argument("--summary", action="store_true", help="print the roster and exit")
    args = parser.parse_args()
    stream_log, api_log = Path(args.stream_log), Path(args.api_log)

    if args.summary:
        summary(stream_log, api_log)
        return

    print(f"watching decisions\n  bridge: {stream_log}\n  server: {api_log}\n")
    s_off = stream_log.stat().st_size if stream_log.exists() else 0
    a_off = api_log.stat().st_size if api_log.exists() else 0
    try:
        while True:
            s_off = follow(stream_log, s_off)
            a_off = follow(api_log, a_off)
            time.sleep(0.3)
    except KeyboardInterrupt:
        print()
        summary(stream_log, api_log)
    except BrokenPipeError:   # piped into head/tee and the reader went away
        pass


if __name__ == "__main__":
    main()
