"""One local daemon for the demo machine: keys, crypto and the band pipeline.

It is the only thing that holds this device's key, so it is the only thing
that can sign or decrypt records. The VM is a dumb encrypted vault.

What it does:
  1. Key handoff for the browser  GET /session  (CORS: only allowed origins)
     -> {device_id, auth, aes_key}; the raw secret never leaves this process.
  2. Band capture (optional --band): BLE/USB -> Opus -> PCM -> local Whisper
     -> extract with a remote Gemma endpoint -> seal with the device key
     -> POST the sealed blob to the records URL (the VM).
  3. Health                        GET /health

Run (keys + browser unlock only):
    .venv/bin/python my-project/local_bridge.py --allow http://localhost:8766
With the band and the whole pipeline:
    .venv/bin/python my-project/local_bridge.py --band --records https://<vm> \
        --ollama http://<teammate-ip>:11434/v1 --allow https://<vm>
"""
import argparse
import asyncio
import base64
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import requests

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "vexo-open-kit" / "python"))

import device_crypto as dc  # noqa: E402

ALLOWED_ORIGINS: set[str] = set()
SECRET = b""
OPTIONS = None  # loaded in main()
WHISPER = None


class KeyHandler(BaseHTTPRequestHandler):
    def _cors(self) -> str:
        origin = self.headers.get("Origin") or ""
        return origin if origin in ALLOWED_ORIGINS else ""

    def _send(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        allow = self._cors()
        if allow:
            self.send_header("Access-Control-Allow-Origin", allow)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        allow = self._cors()
        self.send_response(204)
        if allow:
            self.send_header("Access-Control-Allow-Origin", allow)
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET")
            self.send_header("Vary", "Origin")
        self.end_headers()

    def do_GET(self) -> None:
        path = self.path.split("?")[0]
        allowed = bool(self._cors())
        if path == "/health":
            self._send(200, {"ok": True, "device_id": dc.device_id(SECRET)})
            return
        if path == "/session" and allowed:
            self._send(200, {
                "device_id": dc.device_id(SECRET),
                "auth": dc.auth_token(SECRET),
                "aes_key": base64.b64encode(dc.encryption_key(SECRET)).decode(),
            })
            return
        self._send(403, {"error": "origin not allowed" if not allowed else "not found"})

    def log_message(self, *args) -> None:
        pass


# ---------- band pipeline ----------

NUM_WORDS = {"zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
             "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}

EXTRACTION_PROMPT = """You extract a symptom event from a patient's spoken note.
Return ONLY JSON with these keys:
  body_location: string or null      (e.g. "chest", "head", "stomach")
  quality: string or null            (e.g. "pressure", "sharp", "dizzy")
  severity: integer 0-10 or null     (only if the patient stated it)
  activity: string or null           (e.g. "stairs", "lying down", "after eating")
Never diagnose, never invent details, never guess a code.
If the patient did not say it, use null.
"""


def parse_json_reply(content: str) -> dict:
    """Read the model's JSON even when it wraps it in prose or markdown."""
    text = (content or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError(f"no JSON object in reply: {text[:60]!r}")
    return json.loads(text[start:end + 1])


def transcribe(pcm: bytes, final: bool = False) -> str:
    """Whisper on a live chunk: no hallucinated text on short or silent audio."""
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    segments, _ = WHISPER.transcribe(
        samples, language="en", vad_filter=True,
        condition_on_previous_text=False, no_speech_threshold=0.6,
        beam_size=5 if final else 1)
    return " ".join(s.text.strip() for s in segments).strip()


def _ask(endpoint: str, model: str, quote: str) -> dict:
    """One extraction call. Raises on any failure so the caller can fall back."""
    started = time.time()
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": EXTRACTION_PROMPT},
            {"role": "user", "content": quote},
        ],
        "format": "json", "temperature": 0, "stream": False,
        "response_format": {"type": "json_object"},
    }
    r = requests.post(f"{endpoint}/chat/completions", json=payload, timeout=120)
    r.raise_for_status()
    content = r.json()["choices"][0]["message"]["content"]
    parsed = parse_json_reply(content)
    log_stream("model", role="extract", model=model, endpoint=endpoint,
               seconds=round(time.time() - started, 2), text=quote[:60], ok=True)
    fields = {k: parsed.get(k) for k in ("body_location", "quality", "severity", "activity")}
    # severity is only kept when the patient actually said a number
    if fields["severity"] is not None and not any(
            w in quote.lower().split() for w in NUM_WORDS) and not any(c.isdigit() for c in quote):
        fields["severity"] = None
    return fields


def extract(quote: str) -> tuple[dict, str | None]:
    """Primary endpoint first, the fallback model only if it fails."""
    attempts = [(OPTIONS.ollama, OPTIONS.gemma)]
    if OPTIONS.ollama_fallback and OPTIONS.gemma_fallback:
        attempts.append((OPTIONS.ollama_fallback, OPTIONS.gemma_fallback))
    for endpoint, model in attempts:
        try:
            fields = _ask(endpoint, model, quote)
            return fields, model
        except Exception as exc:
            print(f"extract failed on {model} @ {endpoint}: {type(exc).__name__}: {exc}",
                  flush=True)
    return {}, None


STREAM_LOG = os.environ.get("STREAM_LOG", "/tmp/stream.jsonl")


def iso_now() -> str:
    """Local time with offset, ISO 8601: 2026-11-14T16:14:17-08:00 (never UTC Z)."""
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    return stamp[:-2] + ":" + stamp[-2:] if len(stamp) > 2 else stamp


def log_stream(entry_type: str, **fields) -> None:
    """Append one literal line to the demo stream.

    Everything the pipeline sees goes here — audio levels, band events,
    transcripts, labels, routes, model calls (with latency), API calls, errors —
    so the logger shows the whole system, not just the decisions.
    """
    line = json.dumps({"t": time.strftime("%H:%M:%S"), "type": entry_type, **fields})
    try:
        with open(STREAM_LOG, "a") as fh:
            fh.write(line + "\n")
    except OSError as exc:
        print(f"stream log failed: {exc}", flush=True)


MED_WORDS = ("medicine", "medication", "med", "pill", "tablet", "dose")
ORDINALS = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5,
            "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5}


def push_sealed(event: dict, kind: str = "Observation") -> None:
    """Seal with this device's key and hand the VM an opaque blob."""
    sealed = dc.seal(SECRET, json.dumps(event).encode())
    body = json.dumps({"event": {"id": event["id"], "device": dc.device_id(SECRET)},
                       "sealed": sealed}).encode()
    url = f"{OPTIONS.records}/{kind}"
    try:
        r = requests.post(url, data=body, timeout=20, headers={
            "Content-Type": "application/json", "X-Device-Auth": dc.auth_token(SECRET)})
        log_stream("api", method="POST", path=f"/{kind}", status=r.status_code,
                   id=event["id"], bytes=len(body), payload=event)
        print(f"pushed {kind} {event['id']} -> {r.status_code}", flush=True)
    except Exception as exc:
        log_stream("api_error", method="POST", path=f"/{kind}",
                   error=f"{type(exc).__name__}: {exc}")
        print(f"push failed: {type(exc).__name__}: {exc}", flush=True)


def fetch_medicines() -> list[dict]:
    """The medicine list, so 'medicine 2 taken' can be matched by index."""
    url = f"{OPTIONS.records}/MedicationRequest"
    try:
        r = requests.get(url, timeout=20, headers={"X-Device-Auth": dc.auth_token(SECRET)})
        log_stream("api", method="GET", path="/MedicationRequest", status=r.status_code)
        r.raise_for_status()
        return [m for m in r.json() if isinstance(m, dict) and m.get("id")]
    except Exception as exc:
        print(f"could not fetch medicines: {type(exc).__name__}: {exc}", flush=True)
        return []


def parse_taken(quote: str) -> int | None:
    """'medicine 2 taken' -> 2 (1-based). None if the note is not a dose report."""
    low = quote.lower()
    if not any(w in low for w in MED_WORDS):
        return None
    if not any(w in low for w in ("took", "taken", "take", "did")):
        return None
    for word, n in {**NUM_WORDS, **ORDINALS}.items():
        if word in low.split():
            return n
    for token in low.replace(",", " ").split():
        if token.isdigit():
            return int(token)
    return 1   # no number given: assume the single/first medicine


def post_message(quote: str, action: str | None = None) -> None:
    """A note or question for the doctor, sealed like any other record."""
    msg = {
        "schema_version": "0.1",
        "id": f"msg-{int(time.time() * 1000)}",
        "ts": iso_now(),
        "thread": "general",
        "from": "patient",
        "to": "clinician",
        "sender": "You",
        "body": quote,
        "priority": None,
        "action": action,
        "related_event_ids": [],
    }
    push_sealed(msg, "Communication")


def log_taken(quote: str) -> bool:
    """If the patient said they took a medicine, write a sealed administration."""
    index = parse_taken(quote)
    if index is None:
        return False
    medicines = fetch_medicines()
    chosen = medicines[index - 1] if 0 < index <= len(medicines) else None
    taken = {
        "schema_version": "0.1",
        "id": f"adm-{int(time.time() * 1000)}",
        "ts": iso_now(),
        "taken_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "medication_id": chosen.get("id") if chosen else None,
        "medication_name": chosen.get("name") if chosen else f"medicine {index}",
        "dose_taken": chosen.get("dose") if chosen else None,
        "method": "voice",
        "verbatim_quote": quote,
    }
    push_sealed(taken, "MedicationAdministration")
    return True


BUFFER_SECONDS = 12       # rolling window: long enough for whole sentences
PAUSE_SECONDS = 1.0      # this long without audio, the turn is over
MIN_BUFFER_SECONDS = 0.8  # don't bother transcribing less than this
REALTIME_TICK = 0.6      # how often we re-transcribe what is buffered
SPEECH_RMS_FLOOR = 120    # below this a frame is just the room, not a voice
MIN_WORDS = 3             # a 1-2 word fragment is not a report
CHUNK_MS = 20             # the band sends 20 ms Opus packets
SAMPLES_PER_CHUNK = 320   # 20 ms at 16 kHz mono

DECISION_MODEL = "gemma3:4b"        # the small local gate
DECISION_URL = "http://localhost:11434/v1"
DECISION_PROMPT = """You decide whether a patient's spoken sentence contains
something worth logging in their medical record, and which kind it is.
Return ONLY JSON: {"log": true|false,
                   "kind": "symptom"|"dose"|"message"|"visit"|"other",
                   "reason": "short"}
Rules:
- symptom: something they feel (pain, pressure, dizzy, nausea, tightness...).
- dose: a medicine they took ("I took medicine 1").
- message: they are telling or asking the doctor something ("tell my doctor...").
- visit: about an appointment ("I have an appointment tomorrow").
- other: small talk, thanks, counting, background chatter -> log false.
- Never diagnose, never add details that were not said.
"""

LED_PROCESSING = "#ff0000"
LED_SAVED = "#00ff00"
LED_UNCLEAR = "#ffaa00"
LED_HOLD_SECONDS = 1.5


async def set_led(band, colour: str) -> None:
    """Light the band. The mic indicator outranks us while audio is streaming."""
    try:
        await band.set_led(colour)
    except Exception as exc:
        print(f"led {colour} skipped: {type(exc).__name__}: {exc}", flush=True)


def rms(pcm: bytes) -> int:
    if len(pcm) < 2:
        return 0
    samples = np.frombuffer(pcm[:len(pcm) // 2 * 2], dtype=np.int16).astype(np.int32)
    return int(np.sqrt(np.mean(samples ** 2))) if len(samples) else 0


GATE_RETRIES = 3


def _keyword_verdict(quote: str) -> dict:
    dose = parse_taken(quote) is not None
    words = ("pain", "pressure", "dizzy", "sharp", "ache", "nausea", "tired", "chest",
             "head", "stomach", "burning", "tight", "cramp")
    log = dose or any(w in quote.lower().split() for w in words)
    return {"log": log, "kind": "dose" if dose else ("symptom" if log else "other"),
            "reason": "keyword fallback"}


def decide(quote: str) -> dict:
    """The small local gate: should this sentence become a record?

    Bad JSON is retried (models slip on formatting); if every try fails the
    keyword gate decides, so a real report is never lost.
    """
    if len(quote.split()) < MIN_WORDS:
        log_stream("gate", text=quote, log=False, kind="other", reason="too short")
        return {"log": False, "kind": "other", "reason": "too short"}
    payload = {
        "model": DECISION_MODEL,
        "messages": [{"role": "system", "content": DECISION_PROMPT},
                     {"role": "user", "content": quote}],
        "format": "json", "temperature": 0, "stream": False,
        "response_format": {"type": "json_object"},
    }
    for attempt in range(1, GATE_RETRIES + 1):
        started = time.time()
        try:
            r = requests.post(f"{DECISION_URL}/chat/completions", json=payload, timeout=60)
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"]
            answer = parse_json_reply(content)
            if "log" not in answer:
                raise ValueError("no 'log' field")
            kind = answer.get("kind") or "other"
            if kind not in ("symptom", "dose", "message", "visit", "other"):
                kind = "other"
            verdict = {"log": bool(answer.get("log")) and kind != "other",
                       "kind": kind, "reason": answer.get("reason") or ""}
            log_stream("model", role="gate", model=DECISION_MODEL,
                       seconds=round(time.time() - started, 2),
                       attempt=attempt, ok=True)
            log_stream("gate", text=quote, **verdict)
            return verdict
        except (json.JSONDecodeError, ValueError, requests.RequestException, KeyError) as exc:
            log_stream("model", role="gate", model=DECISION_MODEL,
                       seconds=round(time.time() - started, 2),
                       attempt=attempt, ok=False, error=f"{type(exc).__name__}: {exc}")
            print(f"gate attempt {attempt}/{GATE_RETRIES} failed: "
                  f"{type(exc).__name__}: {exc}", flush=True)
    verdict = _keyword_verdict(quote)
    log_stream("gate", text=quote, fallback=True, **verdict)
    return verdict


def process_text(quote: str, utterance: bytes) -> None:
    """A finished transcript: gate, route, and write the record."""
    if not quote:
        return
    verdict = decide(quote)
    print(f"heard {quote!r} -> log={verdict['log']} kind={verdict['kind']} "
          f"({verdict['reason']})", flush=True)
    if not verdict["log"]:
        return
    if verdict["kind"] == "dose" or parse_taken(quote) is not None:
        log_stream("route", text=quote, intent="dose", path="/MedicationAdministration")
        log_taken(quote)
        return
    if verdict["kind"] in ("message", "visit"):
        action = "Book a visit" if verdict["kind"] == "visit" else None
        log_stream("route", text=quote, intent=verdict["kind"], path="/Communication")
        post_message(quote, action)
        return
    log_stream("route", text=quote, intent="symptom", path="/Observation")
    fields, used_model = extract(quote)
    event = {
        "schema_version": "0.1",
        "id": f"evt-{int(time.time() * 1000)}",
        "ts": iso_now(),
        "source": OPTIONS.source,
        "audio_seconds": round(len(utterance) / 2 / 16000, 2),
        "verbatim_quote": quote,
        "transcript_model": "faster-whisper-small",
        "extract_model": used_model if fields else None,
        **fields,
    }
    push_sealed(event)


def common_prefix_words(a: str, b: str) -> str:
    """The words both hypotheses agree on, in order — LocalAgreement-2.

    Compared without punctuation or case ('three,' == 'three.'); the result
    keeps b's original spelling.
    """
    def norm(w: str) -> str:
        return re.sub(r"[^\w']", "", w.lower())

    agreed, b_words = [], b.split()
    for i, w1 in enumerate(a.split()):
        if i >= len(b_words) or norm(w1) != norm(b_words[i]):
            break
        agreed.append(b_words[i])
    return " ".join(agreed)


async def streaming_loop(read_buffer, consume, voice_idle_seconds, buffer_bytes,
                         on_busy=None, on_done=None) -> None:
    """Streaming transcription: words are committed as they are spoken.

    Every tick the rolling window is transcribed; only the prefix that agrees
    with the previous pass is committed, and committed words are only extended,
    never replaced. The turn ends on voice-silence (or a full window), and one
    final pass over the whole turn produces the text that gets recorded.
    """
    committed: list[str] = []
    previous = ""
    while True:
        await asyncio.sleep(REALTIME_TICK)
        snapshot = read_buffer()
        seconds = len(snapshot) / 2 / 16000
        if seconds < MIN_BUFFER_SECONDS:
            continue
        # take the idle time with the same snapshot: a quiet copy holds the whole turn
        quiet = voice_idle_seconds() >= PAUSE_SECONDS
        full = len(snapshot) >= buffer_bytes
        hypothesis = (await asyncio.to_thread(transcribe, snapshot)).strip()
        agreed = common_prefix_words(previous, hypothesis).split()
        if agreed[:len(committed)] == committed and len(agreed) > len(committed):
            fresh = agreed[len(committed):]
            committed += fresh
            log_stream("words", text=" ".join(fresh), so_far=" ".join(committed),
                       audio_s=round(seconds, 2))
        previous = hypothesis
        if not (quiet or full):
            continue
        consume(len(snapshot))
        committed, previous = [], ""
        final_text = (await asyncio.to_thread(transcribe, snapshot, True)).strip()
        if not final_text:
            continue
        log_stream("transcript", text=final_text, audio_s=round(seconds, 2),
                   rms=rms(snapshot))
        if on_busy:
            await on_busy()
        try:
            # the gate and the write are slow: keep the audio loop free
            await asyncio.to_thread(process_text, final_text, snapshot)
        except Exception as exc:
            log_stream("error", stage="process", error=f"{type(exc).__name__}: {exc}")
            print(f"process failed: {type(exc).__name__}: {exc}", flush=True)
        if on_done:
            await on_done()


async def mic_loop() -> None:
    """Streaming transcription from the laptop microphone."""
    import sounddevice as sd

    buffer = bytearray()
    heard = 0
    consumed = 0
    last_voice = 0.0
    lock = threading.Lock()
    buffer_bytes = int(16000 * 2 * BUFFER_SECONDS)

    def on_mic(indata, frames, time_info, status) -> None:
        nonlocal heard, last_voice
        if status:
            log_stream("error", stage="mic", error=str(status))
        pcm = bytes(indata)
        if rms(pcm) >= SPEECH_RMS_FLOOR:
            last_voice = time.time()
        with lock:
            buffer.extend(pcm)
            heard += len(pcm)

    def read_buffer() -> bytes:
        with lock:
            return bytes(buffer)

    def consume(count: int) -> None:
        nonlocal consumed
        with lock:
            keep_from = min(consumed + count, heard)
            del buffer[:keep_from - consumed]
            consumed = keep_from

    stream = sd.RawInputStream(samplerate=16000, channels=1, dtype="int16",
                               blocksize=1600, callback=on_mic)
    stream.start()
    print("microphone: listening — just talk", flush=True)
    try:
        await streaming_loop(read_buffer, consume,
                             lambda: time.time() - last_voice, buffer_bytes)
    finally:
        stream.stop()
        stream.close()


async def band_loop() -> None:
    """Streaming transcription from the band over BLE."""
    from vexo_open import Band as AsyncBand
    from vexo_open.audio import PcmDecoder

    decoder = PcmDecoder()
    band = await AsyncBand.connect(29, transport=OPTIONS.transport)

    buffer = bytearray()     # everything heard since the last consumed turn
    heard = 0                # total bytes ever appended, so a turn consumes a span
    consumed = 0             # bytes already sent for transcription
    last_voice = 0.0         # when something actually sounded (silence is not a voice)
    lock = threading.Lock()
    buffer_bytes = int(16000 * 2 * BUFFER_SECONDS)

    def on_audio(packet) -> None:
        nonlocal heard, last_voice
        pcm = decoder.feed(packet)
        if not pcm:
            return
        if rms(pcm) >= SPEECH_RMS_FLOOR:
            last_voice = time.time()
        with lock:
            buffer.extend(pcm)
            heard += len(pcm)

    def read_buffer() -> bytes:
        with lock:
            return bytes(buffer)

    def consume(count: int) -> None:
        """Drop the turn that was transcribed, keeping anything said meanwhile."""
        nonlocal consumed
        with lock:
            keep_from = min(consumed + count, heard)
            dropped = keep_from - consumed
            del buffer[:dropped]
            consumed = keep_from

    band.on("audio", on_audio)
    for gesture in ("tap", "double-tap", "event"):
        band.on(gesture, lambda e, g=gesture: log_stream(
            "band_event", event=g, detail=str(getattr(e, "kind", "") or "")))

    await band.configure(audio=True)
    print(f"band {band.name} over {OPTIONS.transport}: listening — just talk", flush=True)
    try:
        # the band stays listening while a turn is processed: nothing is lost
        await streaming_loop(read_buffer, consume,
                             lambda: time.time() - last_voice, buffer_bytes)
    finally:
        await band.configure(audio=False)
        await band.disconnect()


def main() -> None:
    global SECRET, ALLOWED_ORIGINS, OPTIONS, WHISPER
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8768)
    parser.add_argument("--band", action="store_true", help="also run the band pipeline")
    parser.add_argument("--mic", action="store_true", help="use the laptop microphone instead")
    parser.add_argument("--transport", default="ble", choices=["ble", "serial"])
    parser.add_argument("--records", default="http://localhost:8766")
    parser.add_argument("--ollama", default="http://localhost:11434/v1")
    parser.add_argument("--gemma", default="gemma3:12b")
    parser.add_argument("--ollama-fallback", default="",
                        help="secondary extraction endpoint, used if the primary fails")
    parser.add_argument("--gemma-fallback", default="",
                        help="secondary model name for the fallback endpoint")
    parser.add_argument("--whisper", default="/tmp/faster-whisper-small")
    parser.add_argument("--allow", nargs="*", default=["http://localhost:8766"])
    OPTIONS = parser.parse_args()

    SECRET = dc.load_or_create_secret()
    ALLOWED_ORIGINS = set(OPTIONS.allow)

    print(f"local bridge on http://127.0.0.1:{OPTIONS.port}/ for device {dc.device_id(SECRET)}")
    print("allowed origins:", ", ".join(sorted(ALLOWED_ORIGINS)))
    print(f"records: {OPTIONS.records} | gemma: {OPTIONS.gemma} @ {OPTIONS.ollama}")
    if OPTIONS.ollama_fallback:
        print(f"fallback: {OPTIONS.gemma_fallback} @ {OPTIONS.ollama_fallback}")
    threading.Thread(
        target=lambda: ThreadingHTTPServer(("127.0.0.1", OPTIONS.port), KeyHandler).serve_forever(),
        daemon=True).start()

    OPTIONS.source = "mic" if OPTIONS.mic else "band"
    if OPTIONS.band or OPTIONS.mic:
        from faster_whisper import WhisperModel
        WHISPER = WhisperModel(OPTIONS.whisper, device="cpu", compute_type="int8")
        asyncio.run(mic_loop() if OPTIONS.mic else band_loop())
        return
    print("no --band: key handoff only. Ctrl+C to stop.", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
