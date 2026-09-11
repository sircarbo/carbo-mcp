#!/bin/bash
# Pull the LinkStation NAS login from Vaultwarden and write the mount.cifs
# credentials file, without ever displaying the password.
#
#   bash /opt/carbo-mcp/scripts/linkstation-creds-from-vault.sh ["<vault item name>"]
#
# Run it as yourself (sircarbo). If BW_SESSION is not set it unlocks the vault
# first (asks for your master password in this terminal). Then it finds the
# item (default search: "LinkStation"), writes username/password to a temp
# file, installs it as /root/.smbcreds-linkstation (root, 0600) via sudo, and
# shreds the temp file.
set -euo pipefail
export NODE_TLS_REJECT_UNAUTHORIZED=0   # vault.carbo.lan is self-signed
ITEM="${1:-LinkStation}"
DEST=/root/.smbcreds-linkstation

# Vaultwarden 1.32.7 predates the login endpoint that Bitwarden CLI 2026.x
# uses (POST /identity/accounts/prelogin/password -> 404), so a pinned older
# CLI is preferred when present. Override with BW=/path/to/bw.
LEGACY_BW="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tools/bw-2025.7.0"
if [ -z "${BW:-}" ] && [ -x "$LEGACY_BW" ]; then BW="$LEGACY_BW"; fi
BW="${BW:-bw}"
bw() { "$BW" "$@"; }

if [ -z "${BW_SESSION:-}" ]; then
  st=$(bw status 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status",""))' || true)
  if [ "$st" = "unauthenticated" ]; then
    echo "Bitwarden CLI is not logged in. Logging in to vault.carbo.lan..."
    bw config server https://vault.carbo.lan >/dev/null
    export BW_SESSION="$(bw login --raw)" || true
  else
    export BW_SESSION="$(bw unlock --raw)" || true
  fi
fi
if [ -z "${BW_SESSION:-}" ]; then
  echo "Vault login/unlock did not return a session (wrong email/master password, or a 2FA prompt was refused). Nothing written." >&2
  exit 1
fi
bw sync --session "$BW_SESSION" >/dev/null 2>&1 || true

TMP=$(mktemp); chmod 0600 "$TMP"; trap 'shred -u "$TMP" 2>/dev/null || rm -f "$TMP"' EXIT
bw list items --search "$ITEM" --session "$BW_SESSION" 2>/dev/null \
  | ITEM="$ITEM" python3 -c '
import os, sys, json
want = os.environ["ITEM"].lower()
items = [i for i in json.load(sys.stdin) if i.get("login") and want in (i.get("name") or "").lower()]
if not items:
    sys.stderr.write("No vault item matching \"%s\" with a login. Pass the exact item name as the first argument.\n" % os.environ["ITEM"]); sys.exit(1)
if len(items) > 1:
    sys.stderr.write("Several items match: " + ", ".join(i["name"] for i in items) + "\nPass the exact item name as the first argument.\n"); sys.exit(1)
l = items[0]["login"]
u, p = l.get("username") or "", l.get("password") or ""
if not u or not p:
    sys.stderr.write("Item \"%s\" is missing a username or password.\n" % items[0]["name"]); sys.exit(1)
sys.stdout.write("username=%s\npassword=%s\n" % (u, p))
sys.stderr.write("Using vault item: %s (username %s)\n" % (items[0]["name"], u))
' > "$TMP"

sudo install -m 0600 -o root -g root "$TMP" "$DEST"
echo "Saved $DEST (password not shown)."
