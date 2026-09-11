#!/bin/bash
# Store the Kling AI API key for the Carbo MCP Gateway.
#
#   sudo bash /opt/carbo-mcp/scripts/set-kling-key.sh
#
# Prompts for the key (typing/pasting is hidden), writes it to
# secrets/kling_api_key readable by the gateway (uid 65532) and nobody else,
# and never prints the key. Re-run to replace a rotated key.
set -euo pipefail
DEST="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/secrets/kling_api_key"
OWNER="${SUDO_USER:-claudebot}"

printf 'Paste the Kling API key, then press Enter (nothing is shown while you paste): '
read -rs KEY
echo
KEY="${KEY//[$'\r\n\t ']/}"
if [ -z "$KEY" ]; then echo "Nothing entered; no file written."; exit 1; fi

umask 077
printf '%s' "$KEY" > "$DEST"
chown "$OWNER":65532 "$DEST"
chmod 0640 "$DEST"
unset KEY

echo "Saved to $DEST (key not shown). Owner $(stat -c '%U:%g mode %a' "$DEST")."
