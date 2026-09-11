#!/bin/bash
# Store the LinkStation NAS (10.0.0.129) SMB login for the carbo-server mount.
#
#   sudo bash /opt/carbo-mcp/scripts/set-linkstation-creds.sh
#
# Prompts for the NAS username and password (password hidden), writes
# /root/.smbcreds-linkstation in the mount.cifs credentials format, mode 0600,
# root only. Never prints the password. Re-run to replace it.
set -euo pipefail
DEST=/root/.smbcreds-linkstation
read -rp 'LinkStation username: ' U
read -rsp 'LinkStation password (hidden): ' P; echo
[ -n "$U" ] && [ -n "$P" ] || { echo "Both are required; nothing written."; exit 1; }
umask 077
printf 'username=%s\npassword=%s\n' "$U" "$P" > "$DEST"
chmod 0600 "$DEST"; chown root:root "$DEST"
unset P
echo "Saved $DEST for user '$U' (password not shown)."
