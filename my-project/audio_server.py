"""Band audio -> local transcription -> local extraction, served over HTTP.

Pipeline (all local, nothing leaves the machine):
    band (BLE/USB, Opus 20 ms packets)
      -> vexo_open.audio.PcmDecoder (16 kHz mono PCM)
      -> faster-whisper (speech to text, on-device)
      -> Gemma via Ollama (text -> structured symptom event JSON)
      -> in-memory event log, also POSTed to the records API

Run:
    .venv/bin/python my-project/audio_server.py --transport ble --ollama http://<teammate-ip>:11434/v1
Endpoints:
    GET /events   the event log as JSON
"""

import argparse
import asyncio
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import requests
from faster_whisper import WhisperModel

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "vexo-open-kit" / "python"))

from vexo_open import Band as AsyncBand  # noqa: E402
from vexo_open.audio import PcmDecoder  # noqa: E402

EVENTS: list[dict] = []
EVENTS_LOCK = threading.Lock()

SCHEMA_VERSION = "0.1"
SERVER_PORT = 8765
BAND_NUMBER = 29
SAMPLE_RATE = 16000
CHUNKS_PER_UTTERANCE = 40  # 40 * 20 ms = 0.8 s of audio per transcription window
WHISPER_MODEL_DIR = os.environ.get("WHISPER_MODEL", "/tmp/faster-whisper-small")
DEFAULT_OLLAMA = os.environ.get("OLLAMA_URL", "http://172.17.27.153:11434/v1")
GEMMA_MODEL = os.environ.get("GEMMA_MODEL", "gemma3:12b")

EXTRACTION_PROMPT = """You extract a symptom event from a patient's spoken note.
Return ONLY JSON with these keys:
  body_location: string or null      (e.g. "chest", "head", "stomach")
  quality: string or null            (e.g. "pressure", "sharp", "dizzy")
  severity: integer 0-10 or null     (only if the patient stated it)
  activity: string or null           (e.g. "stairs", "lying down", "after eating")
Never diagnose, never invent details, never guess a code.
If the patient did not say it, use null.
"""


def add_event(event: dict) -> None:
    with EVENTS_LOCK:
        EVENTS.append(event)
    print("EVENT", json.dumps(event), flush=True)


class EventsHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if not self.path.startswith("/events"):
            self.send_response(404)
            self.end_headers()
            return
        with EVENTS_LOCK:
            body = json.dumps(EVENTS).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # the band side can also push events in
        if not self.path.startswith("/events"):
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0))
        event = json.loads(self.rfile.read(length) or b"{}")
        add_event(event)
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

    def log_message(self, *args) -> None:
        pass


def start_server(port: int) -> None:
    ThreadingHTTPServer(("0.0.0.0", port), EventsHandler).serve_forever()


def pcm_to_text(model: WhisperModel, pcm: bytes) -> str:
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    segments, _ = model.transcribe(samples, language="en")
    return " ".join(s.text.strip() for s in segments).strip()


def extract_event(ollama_url: str, quote: str) -> dict:
    """Ask Gemma for the structured fields. Returns {} if the model is unreachable."""
    payload = {
        "model": GEMMA_MODEL,
        "messages": [
            {"role": "system", "content": EXTRACTION_PROMPT},
            {"role": "user", "content": quote},
        ],
        "format": "json",
        "temperature": 0,
        "stream": False,
    }
    try:
        r = requests.post(f"{ollama_url}/chat/completions", json=payload, timeout=60)
        r.raise_for_status()
        content = r.json()["choices"][0]["message"]["content"]
        parsed = json.loads(content)
    except Exception as exc:  # unreachable endpoint or bad JSON: keep the quote only
        print(f"extract skipped: {type(exc).__name__}: {exc}", flush=True)
        return {}
    return {
        "body_location": parsed.get("body_location"),
        "quality": parsed.get("quality"),
        "severity": parsed.get("severity"),
        "activity": parsed.get("activity"),
    }


def post_to_records_api(records_url: str, event: dict) -> None:
    if not records_url:
        return
    try:
        requests.post(f"{records_url}/Observation", json=event, timeout=10)
    except Exception as exc:
        print(f"records API unreachable: {type(exc).__name__}: {exc}", flush=True)


async def capture_loop(
    band: AsyncBand, whisper: WhisperModel, ollama_url: str, records_url: str
) -> None:
    decoder = PcmDecoder()
    buffer = bytearray()
    chunk_count = 0

    def on_audio(packet) -> None:
        nonlocal chunk_count
        pcm = decoder.feed(packet)
        if pcm:
            buffer.extend(pcm)
            chunk_count += 1

    band.on("audio", on_audio)
    await band.configure(audio=True)
    print("microphone on (solid blue), listening...", flush=True)
    try:
        while True:
            await asyncio.sleep(0.5)
            if chunk_count < CHUNKS_PER_UTTERANCE:
                continue
            pcm = bytes(buffer)
            buffer.clear()
            chunk_count = 0
            quote = await asyncio.to_thread(pcm_to_text, whisper, pcm)
            if not quote:
                continue
            fields = await asyncio.to_thread(extract_event, ollama_url, quote)
            event = {
                "schema_version": SCHEMA_VERSION,
                "id": f"evt-{int(time.time() * 1000)}",
                "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "source": "band",
                "audio_seconds": round(len(pcm) / 2 / SAMPLE_RATE, 2),
                "verbatim_quote": quote,
                "transcript_model": "faster-whisper-small",
                "extract_model": GEMMA_MODEL if fields else None,
                **fields,
            }
            add_event(event)
            await asyncio.to_thread(post_to_records_api, records_url, event)
    finally:
        await band.configure(audio=False)
        await band.disconnect()


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--transport", default="ble", choices=["ble", "serial"])
    parser.add_argument("--ollama", default=DEFAULT_OLLAMA)
    parser.add_argument("--records", default="")
    parser.add_argument("--seconds", type=float, default=60)
    args = parser.parse_args()

    threading.Thread(target=start_server, args=(SERVER_PORT,), daemon=True).start()
    print(f"server on http://0.0.0.0:{SERVER_PORT}/events", flush=True)

    whisper = await asyncio.to_thread(
        WhisperModel, WHISPER_MODEL_DIR, device="cpu", compute_type="int8"
    )
    band = await AsyncBand.connect(BAND_NUMBER, transport=args.transport)
    print(f"band connected: {band.name} over {args.transport}", flush=True)

    capture = asyncio.create_task(
        capture_loop(band, whisper, args.ollama, args.records)
    )
    await asyncio.sleep(args.seconds)
    capture.cancel()
    try:
        await capture
    except asyncio.CancelledError:
        pass


if __name__ == "__main__":
    asyncio.run(main())
