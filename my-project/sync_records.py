"""Sync the local records to the VM vault — one way, as sealed blobs.

The bridge writes to the local records server; the VM dashboard reads the
vault. This copies each record across, re-sealed with the device key, so the
VM only ever holds ciphertext it cannot read.

Usage:
    set -a && . ./.env && set +a
    .venv/bin/python my-project/sync_records.py [--local http://localhost:8766]

The VM address and preview token come from the running keepalive session's
sandbox (SANDBOX_ID below); the signed URL is fetched fresh each run.
"""

import argparse
import sys
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import device_crypto as dc  # noqa: E402

KINDS = ("Observation", "Encounter", "MedicationRequest",
         "MedicationAdministration", "Communication")
SANDBOX_ID = "b4b3521b-84a5-40e8-8968-a58c36aa4fc2"


def local_counts(base: str, headers: dict) -> dict[str, int]:
    """Cheap change check: the record count per kind, so a quiet vault costs nothing."""
    out = {}
    for kind in KINDS:
        r = requests.get(f"{base}/{kind}", headers=headers, timeout=30)
        out[kind] = len(r.json()) if r.status_code == 200 else 0
    return out


def local_records(base: str) -> dict[str, list[dict]]:
    """Everything the device can read from the local server."""
    secret = dc.load_or_create_secret()
    headers = {"X-Device-Auth": dc.auth_token(secret)}
    out = {}
    for kind in KINDS:
        r = requests.get(f"{base}/{kind}", headers=headers, timeout=30)
        out[kind] = r.json() if r.status_code == 200 else []
    return out


def vm_session() -> tuple[requests.Session, str]:
    """A session for the VM vault: preview token as a cookie, then the host."""
    import asyncio
    from superserve import AsyncSandbox

    async def signed_url() -> str:
        sb = await AsyncSandbox.connect(SANDBOX_ID)
        return await sb.get_signed_preview_url(8766, expires_in_seconds=86400)

    url = asyncio.run(signed_url())
    host, token = url.split("?")[0], url.split("superserve_preview_token=")[1]
    session = requests.Session()
    session.cookies.set("__Host-superserve_preview_token", token)
    return session, host


def vm_ids(session: requests.Session, host: str, headers: dict) -> dict[str, set[str]]:
    out = {}
    for kind in KINDS:
        r = session.get(f"{host}/{kind}", headers=headers, timeout=30)
        out[kind] = {o.get("id") for o in r.json()} if r.status_code == 200 else set()
    return out


SYNC_INTERVAL = 1
SIGNED_URL_REFRESH = 12 * 3600   # re-sign every 12 h; the token itself is valid 24 h


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--local", default="http://localhost:8766")
    parser.add_argument("--watch", action="store_true",
                        help="keep syncing every few seconds (for the live demo)")
    args = parser.parse_args()

    if args.watch:
        import time
        session = host = None
        signed_at = 0.0
        while True:
            try:
                # the signed URL lives 24 h: refresh it every 12 h, not every tick
                if session is None or time.time() - signed_at > SIGNED_URL_REFRESH:
                    session, host = vm_session()
                    signed_at = time.time()
                sync_once(args.local, session, host)
            except Exception as exc:
                print(f"sync failed: {type(exc).__name__}: {exc}")
                session = host = None   # next tick re-signs
            time.sleep(SYNC_INTERVAL)
        return
    sync_once(args.local)


def sync_once(local: str, session: requests.Session | None = None,
              host: str | None = None) -> None:

    secret = dc.load_or_create_secret()
    headers = {"X-Device-Auth": dc.auth_token(secret)}
    records = local_records(local)
    if session is None or host is None:
        session, host = vm_session()
    seen = vm_ids(session, host, headers)

    copied = 0
    for kind, items in records.items():
        for item in items:
            rid = item.get("id")
            if not rid or rid in seen[kind]:
                continue
            sealed = dc.seal(secret, str(item).encode() if not isinstance(item, dict)
                             else __import__("json").dumps(item).encode())
            body = {"event": {"id": rid, "device": dc.device_id(secret)}, "sealed": sealed}
            r = session.post(f"{host}/{kind}", json=body, headers=headers, timeout=30)
            if r.status_code == 201:
                copied += 1
            else:
                print(f"failed {kind} {rid}: {r.status_code} {r.text[:80]}")
    if copied:
        print(f"synced {copied} records to the VM vault")


if __name__ == "__main__":
    main()
