"""Model endpoints on the laptop: the VM calls these, never the other way round.

    POST /transcribe  {"audio_b64": "<16 kHz mono s16 PCM>"} -> {"text": "..."}
    POST /extract     {"text": "..."} -> symptom fields JSON (Gemma via Ollama)
    GET  /health      what is loaded and where Gemma lives
Run: .venv/bin/python my-project/model_server.py --port 8767 --ollama http://localhost:11434/v1
"""

import argparse
import base64
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import requests
from faster_whisper import WhisperModel

WHISPER_MODEL_DIR = os.environ.get("WHISPER_MODEL", "/tmp/faster-whisper-small")
GEMMA_MODEL = os.environ.get("GEMMA_MODEL", "gemma3:12b")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434/v1")

EXTRACTION_PROMPT = """You extract a symptom event from a patient's spoken note.
Return ONLY JSON with these keys:
  body_location: string or null      (e.g. "chest", "head", "stomach")
  quality: string or null            (e.g. "pressure", "sharp", "dizzy")
  severity: integer 0-10 or null     (only if the patient stated it)
  activity: string or null           (e.g. "stairs", "lying down", "after eating")
Never diagnose, never invent details, never guess a code.
If the patient did not say it, use null.
"""

WHISPER = None


def transcribe(pcm: bytes) -> str:
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    segments, _ = WHISPER.transcribe(samples, language="en")
    return " ".join(s.text.strip() for s in segments).strip()


def extract(text: str) -> dict:
    payload = {
        "model": GEMMA_MODEL,
        "messages": [
            {"role": "system", "content": EXTRACTION_PROMPT},
            {"role": "user", "content": text},
        ],
        "format": "json",
        "temperature": 0,
        "stream": False,
    }
    try:
        r = requests.post(f"{OLLAMA_URL}/chat/completions", json=payload, timeout=120)
        r.raise_for_status()
        content = r.json()["choices"][0]["message"]["content"]
        parsed = json.loads(content)
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}
    return {
        "body_location": parsed.get("body_location"),
        "quality": parsed.get("quality"),
        "severity": parsed.get("severity"),
        "activity": parsed.get("activity"),
        "extract_model": GEMMA_MODEL,
    }


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _read(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, {"whisper": WHISPER_MODEL_DIR, "gemma": GEMMA_MODEL,
                             "ollama": OLLAMA_URL})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        body = self._read()
        if self.path == "/transcribe":
            pcm = base64.b64decode(body.get("audio_b64", ""))
            text = transcribe(pcm) if pcm else ""
            self._json(200, {"text": text, "engine": "faster-whisper-small"})
            return
        if self.path == "/extract":
            self._json(200, extract(body.get("text", "")))
            return
        self._json(404, {"error": "not found"})

    def log_message(self, *args) -> None:
        pass


def main() -> None:
    global WHISPER
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8767)
    parser.add_argument("--ollama", default=OLLAMA_URL)
    args = parser.parse_args()
    os.environ["OLLAMA_URL"] = args.ollama
    globals()["OLLAMA_URL"] = args.ollama
    WHISPER = WhisperModel(WHISPER_MODEL_DIR, device="cpu", compute_type="int8")
    print(f"model server on http://0.0.0.0:{args.port}/ "
          f"(gemma via {args.ollama})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
