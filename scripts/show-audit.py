#!/usr/bin/env python3
"""
Prints recent audit events in a readable form.

Reads only what the gateway already wrote: the records are redacted at write
time, so nothing here needs to sanitize anything. Parameters are shown as the
key/shape summary the gateway stored, never as values.
"""
import json
import sys
from pathlib import Path

LOG = Path(__file__).resolve().parent.parent / "data" / "audit" / "audit.log"


def main() -> int:
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 40
    if not LOG.exists():
        print(f"no audit log yet at {LOG}")
        return 0

    try:
        lines = LOG.read_text(errors="replace").splitlines()
    except PermissionError:
        print(f"cannot read {LOG} -- try: sudo {' '.join(sys.argv)}")
        return 1

    print(
        f"{'timestamp':<26} {'event':<13} {'what':<34} {'outcome':<12} "
        f"{'ms':>6} {'http':>5}  subject"
    )
    print("-" * 125)
    for line in lines[-limit:]:
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue

        # Tool calls name a tool; protocol events name a JSON-RPC method, and
        # an initialize is far more useful with the client that sent it.
        what = e.get("toolName") or e.get("method") or "-"
        detail = e.get("detail") or {}
        client = detail.get("clientName")
        if client:
            what = f"{what} ({client})"
        bad_version = detail.get("requestedProtocolVersion")
        if bad_version and e.get("outcome") != "success":
            what = f"{what} v={bad_version}"

        print(
            f"{e.get('timestamp',''):<26} "
            f"{e.get('event',''):<13} "
            f"{what[:34]:<34} "
            f"{e.get('outcome',''):<12} "
            f"{str(e.get('durationMs','-')):>6} "
            f"{str(e.get('httpStatus','-')):>5}  "
            f"{(e.get('subject') or '')[:12]}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
