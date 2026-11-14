"""Deploy the records server into a Superserve sandbox and publish its port.

Usage:
    set -a && . ./.env && set +a
    .venv/bin/python my-project/deploy_records.py [--sandbox-id <id>] [--port 8766] [--private]

Reads SUPERSERVE_API_KEY from the environment (from .env).
Prints the sandbox id and the preview URL (signed when --private).
"""

import argparse
import os
from pathlib import Path

from superserve import Sandbox

SERVER_FILE = Path(__file__).resolve().parent / "records_server.py"
STATE_FILE = Path(__file__).resolve().parent / ".sandbox_id"


def new_sandbox() -> str:
    sb = Sandbox.create(name="vexo-records-demo")
    STATE_FILE.write_text(sb.id)
    return sb.id


def deploy(sandbox_id: str, port: int, private: bool) -> str:
    sb = Sandbox.connect(sandbox_id)
    sb.files.write("/workspace/records_server.py", SERVER_FILE.read_text())

    for existing in (sb.list_preview_ports().ports or []):
        p = existing.port if hasattr(existing, "port") else existing
        sb.unpublish_preview_port(p)

    start = (
        "mkdir -p data && pkill -f records_server.py; sleep 1; "
        f"nohup python3 records_server.py --port {port} > /tmp/records.log 2>&1 & "
        f"sleep 1; curl -s http://localhost:{port}/ -o /dev/null -w '%{{http_code}}'"
    )
    result = sb.commands.run(start, cwd="/workspace")
    print(f"local check inside sandbox: HTTP {result.stdout.strip()}")

    access = "private" if private else "public"
    sb.publish_preview_port(port, access=access)
    if private:
        return sb.get_signed_preview_url(port, expires_in_seconds=86400)
    return sb.get_preview_url(port)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sandbox-id", default=None)
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--private", action="store_true")
    args = parser.parse_args()

    if not os.environ.get("SUPERSERVE_API_KEY"):
        print("SUPERSERVE_API_KEY not set — run: set -a && . ./.env && set +a")
        return

    sandbox_id = args.sandbox_id
    if not sandbox_id and STATE_FILE.exists():
        sandbox_id = STATE_FILE.read_text().strip() or None
    if not sandbox_id:
        sandbox_id = new_sandbox()
        print("created sandbox", sandbox_id)

    url = deploy(sandbox_id, args.port, args.private)
    print("sandbox:", sandbox_id)
    print("url:", url)


if __name__ == "__main__":
    main()
