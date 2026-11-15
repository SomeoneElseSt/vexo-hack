"""Live demo logger — what the band heard, what the gate decided, where it went.

One block per utterance, colour-coded, in the aie-hack style:

    ─ 16:01:16 ─────────────────────────────────────────────
    ●  speech        rms=915 > thr=479 (floor 192) — the patient is talking
    ♪  utterance     3.2s (3100 ms speech)
    ¶  transcript    'sharp chest pain, six out of ten'
    ✓  gate          log symptom → /Observation  (chest pain with a severity)
    →  route         POST /Observation 201 evt-1789  (sealed, 210 B)

and a roster at the end (Ctrl-C), also written to my-project/data/roster.json.

Usage:
    .venv/bin/python my-project/watch.py               # follow the live streams
    .venv/bin/python my-project/watch.py --summary     # print the roster and exit
"""

import argparse
import json
import re
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

# ── colour ────────────────────────────────────────────────────────────────
RESET, DIM, BOLD = "\033[0m", "\033[2m", "\033[1m"
RED, GREEN, YELLOW, BLUE, CYAN, MAGENTA = (
    "\033[31m", "\033[32m", "\033[33m", "\033[34m", "\033[36m", "\033[35m")


def paint(text: str, colour: str) -> str:
    return f"{colour}{text}{RESET}"


ANSI = re.compile(r"\033\[[0-9;]*m")


def pad(text: str, width: int) -> str:
    """Left-align in a visible-width column (colour codes don't count)."""
    visible = len(ANSI.sub("", text))
    return text + " " * max(width - visible, 0)


# ── roster ────────────────────────────────────────────────────────────────
def load_roster() -> dict:
    if ROSTER.exists():
        return json.loads(ROSTER.read_text())
    return {"history": [], "totals": Counter()}


def save_roster(roster: dict, totals: Counter) -> None:
    ROSTER.parent.mkdir(parents=True, exist_ok=True)
    data = {"history": roster["history"][-200:], "totals": dict(totals)}
    ROSTER.write_text(json.dumps(data, indent=1))


# ── one pretty line per entry ─────────────────────────────────────────────
def line_speech(entry: dict) -> str:
    return (pad(paint("● speech", GREEN), 22)
            + f"rms={entry.get('rms')} > thr={entry.get('threshold')} "
              f"(floor {entry.get('floor')}) — the patient is talking")


def line_utterance(entry: dict) -> str:
    return (pad(paint("♪ utterance", BLUE), 22)
            + f"{entry.get('audio_s')}s ({entry.get('speech_ms')} ms speech)")


def line_vad_drop(entry: dict) -> str:
    return (pad(paint("✗ dropped", RED), 22)
            + f"{entry.get('reason')} — {entry.get('audio_s')}s was too brief to send")


def line_transcript(entry: dict) -> str:
    return (pad(paint("¶ transcript", CYAN), 22)
            + f"{entry.get('text', '')!r}")


def line_gate(entry: dict) -> str:
    kind = entry.get("kind") or "other"
    why = (entry.get("reason") or "")[:46]
    if entry.get("log"):
        target = ROUTE.get(kind, "nothing")
        tag = paint(f"✓ gate  {kind:<8} → {target}", GREEN)
    else:
        tag = paint(f"· gate  {kind:<8} → nothing", YELLOW)
    return pad(tag, 46) + " " + paint(f"({why})", DIM)


def line_route(entry: dict) -> str:
    return (pad(paint("→ route", MAGENTA), 22)
            + f"{entry.get('path')}  {entry.get('text', '')[:44]!r}")


def line_api(entry: dict) -> str:
    status = entry.get("status") or 0
    colour = GREEN if 200 <= status < 400 else RED
    note = f" {entry['id']}" if entry.get("id") else ""
    size = f"  ({entry['bytes']} B)" if entry.get("bytes") else ""
    who = entry.get("who") or "bridge"
    head = (pad(paint("→ api", MAGENTA), 22)
            + f"{entry.get('method', 'GET')} {entry.get('path')} "
            + paint(f"{status}", colour) + f"{note}{size}  ({who})")
    payload = entry.get("payload")
    if not payload:
        return head
    # what was actually sent: the fields a reader cares about, not the raw blob
    keep = ("ts", "source", "verbatim_quote", "body_location", "quality",
            "severity", "activity", "extract_model")
    shown = {k: payload[k] for k in keep if payload.get(k) is not None}
    body = json.dumps(shown, ensure_ascii=False)
    return head + "\n" + " " * 25 + paint(body, DIM)


def line_model(entry: dict) -> str:
    ok = entry.get("ok")
    tag = paint(f"◑ {entry.get('role', 'model')}", CYAN if ok else RED)
    verdict = "ok" if ok else f"FAILED {(entry.get('error') or '')[:34]}"
    return (pad(tag, 22)
            + f"{entry.get('model')}  {entry.get('seconds')}s  "
              f"attempt {entry.get('attempt', 1)}  {verdict}")


def line_band_event(entry: dict) -> str:
    return (pad(paint("◆ band", YELLOW), 22)
            + f"{entry.get('event')} {entry.get('detail', '')}".strip())


def line_generic(entry: dict) -> str:
    fields = {k: v for k, v in entry.items() if k not in ("t", "type")}
    text = ", ".join(f"{k}={v}" for k, v in fields.items())
    return pad(paint(str(entry.get("type")), DIM), 22) + text[:90]


RENDER = {
    "speech": line_speech, "utterance": line_utterance, "vad_drop": line_vad_drop,
    "transcript": line_transcript, "gate": line_gate, "route": line_route,
    "api": line_api, "model": line_model, "band_event": line_band_event,
}


def separator(at: str) -> str:
    rule = "─" * 56
    return paint(f"─ {at} {rule}", DIM)


# ── the streams ──────────────────────────────────────────────────────────
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
    models = [e for e in entries if e.get("type") == "model" and e.get("ok")]
    failures = [e for e in entries if e.get("type") in ("vad_drop", "model")
                and (e.get("type") == "vad_drop" or not e.get("ok"))]
    pass_rate = round(len(logged) / len(gates), 3) if len(gates) else 0.0
    avg_seconds = (round(sum(e.get("seconds") or 0 for e in models) / len(models), 2)
                   if len(models) else 0.0)

    roster = load_roster()
    roster["history"].append({
        "type": "all", "decision": "live", "pass_rate": pass_rate,
        "by_intent": {i: by_intent.get(i, 0) for i in INTENTS if by_intent.get(i)},
        "avg_seconds": avg_seconds, "failures": len(failures),
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
    })
    totals = Counter(roster.get("totals") or {})
    totals.update({"transcripts": len(transcripts), "logged": len(logged),
                   "dropped": len(gates) - len(logged), "api_calls": len(api_calls)})
    save_roster(roster, totals)

    print()
    print(paint(f"all: {len(gates)} gate decisions, {len(logged)} logged "
                f"({pass_rate:.0%}) {dict(by_intent)} | {len(transcripts)} transcripts | "
                f"{len(api_calls)} api calls | {avg_seconds}s avg model | "
                f"{len(failures)} failures", BOLD))
    for failure in failures[-5:]:
        kind = failure.get("type")
        detail = (failure.get("reason") or failure.get("error") or "")[:70]
        print("  " + paint(f"FAIL {kind} | {detail}", RED))
    print(paint(f"roster written to {ROSTER}", DIM))


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
            if entry.get("type") == "speech":
                print(separator(entry.get("t", "")), flush=True)
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

    print(paint("watching the band", BOLD)
          + paint(f"  ·  stream {stream_log}  ·  api {api_log}", DIM))
    print()
    s_off = stream_log.stat().st_size if stream_log.exists() else 0
    a_off = api_log.stat().st_size if api_log.exists() else 0
    try:
        while True:
            s_off = follow(stream_log, s_off)
            a_off = follow(api_log, a_off)
            time.sleep(0.3)
    except KeyboardInterrupt:
        summary(stream_log, api_log)
    except BrokenPipeError:   # piped into head/tee and the reader went away
        pass


if __name__ == "__main__":
    main()
