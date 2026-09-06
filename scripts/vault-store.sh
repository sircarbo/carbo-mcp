#!/bin/bash
# Store the Carbo MCP Gateway credentials in Vaultwarden.
#
# Follows the same conventions as /opt/carbo-design/ops/vw-add.sh: requires an
# already-unlocked session, reads values from files, and NEVER prints a secret.
#
#   export BW_SESSION="$(bw unlock --raw)"
#   bash /opt/carbo-mcp/scripts/vault-store.sh
#
# Idempotent: an item whose name already exists is updated in place, so this can
# be re-run after rotating any of these.
set -uo pipefail
export NODE_TLS_REJECT_UNAUTHORIZED=0    # vault.carbo.lan is self-signed

SECRETS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/secrets"
FOLDER_NAME="Services"

[ -n "${BW_SESSION:-}" ] || {
  echo 'BW_SESSION is not set. Run: export BW_SESSION="$(bw unlock --raw)"'
  exit 1
}

read_secret() { [ -s "$1" ] && cat "$1" || printf ''; }

KC_USER_PW=$(read_secret "$SECRETS/keycloak_user_password")
KC_ADMIN_PW=$(read_secret "$SECRETS/keycloak_admin_password")
KC_DB_PW=$(read_secret "$SECRETS/keycloak_db_password")
CONNECTOR_SECRET=$(read_secret "$SECRETS/claude_connector_client_secret")
DESIGN_TOKEN=$(read_secret "$SECRETS/carbo_design_api_token")
KUMA_KEY=$(read_secret "$SECRETS/uptime_kuma_api_key")

bw sync --session "$BW_SESSION" >/dev/null 2>&1

FOLDER_ID=$(bw list folders --session "$BW_SESSION" 2>/dev/null \
  | FOLDER_NAME="$FOLDER_NAME" python3 -c '
import os, sys, json
want = os.environ["FOLDER_NAME"].lower()
try: data = json.load(sys.stdin)
except Exception: data = []
for f in data:
    if (f.get("name") or "").lower() == want:
        print(f["id"]); break
')
if [ -z "$FOLDER_ID" ]; then
  FOLDER_ID=$(printf '{"name":"%s"}' "$FOLDER_NAME" | base64 -w0 \
    | bw create folder --session "$BW_SESSION" 2>/dev/null \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])' 2>/dev/null)
  echo "  created folder: $FOLDER_NAME"
else
  echo "  using existing folder: $FOLDER_NAME"
fi

created=0; updated=0; skipped=0

mkitem() { # name username password uri note
  local name="$1" user="$2" pw="$3" uri="$4" note="$5" existing_id payload

  if [ -z "$pw" ]; then
    echo "  skip (no value on disk): $name"; skipped=$((skipped+1)); return
  fi

  existing_id=$(bw list items --search "$name" --session "$BW_SESSION" 2>/dev/null \
    | ITEM_NAME="$name" python3 -c '
import os, sys, json
want = os.environ["ITEM_NAME"]
try: data = json.load(sys.stdin)
except Exception: data = []
for i in data:
    if i.get("name") == want:
        print(i["id"]); break
')

  payload=$(python3 - "$name" "$user" "$pw" "$uri" "$note" "$FOLDER_ID" <<'PY'
import json, sys
name, user, pw, uri, note, folder = sys.argv[1:7]
print(json.dumps({
    "organizationId": None, "collectionIds": None, "folderId": folder or None,
    "type": 1, "name": name, "notes": note or None, "favorite": False,
    "login": {
        "username": user or None, "password": pw or None,
        "uris": ([{"match": None, "uri": uri}] if uri else None), "totp": None,
    },
    "reprompt": 0,
}))
PY
)

  if [ -n "$existing_id" ]; then
    if printf '%s' "$payload" | base64 -w0 \
       | bw edit item "$existing_id" --session "$BW_SESSION" >/dev/null 2>&1; then
      echo "  updated: $name"; updated=$((updated+1))
    else
      echo "  FAILED to update: $name"
    fi
  else
    if printf '%s' "$payload" | base64 -w0 \
       | bw create item --session "$BW_SESSION" >/dev/null 2>&1; then
      echo "  created: $name"; created=$((created+1))
    else
      echo "  FAILED to create: $name"
    fi
  fi
}

echo "Storing Carbo MCP Gateway credentials..."

mkitem "Carbo MCP - sign-in (Keycloak)" "carbo" "$KC_USER_PW" "https://mcp.carbocomputers.com" \
"THE ONE YOU NEED when Claude.ai asks you to sign in to the MCP connector.

Shown as 'Sign in to Carbo MCP'. Realm: carbo.
Source of truth: /opt/carbo-mcp/secrets/keycloak_user_password (mode 0600).

Not the same as the Uptime Kuma login (admin_carbo) or the Keycloak
administrator (carbo-admin)."

mkitem "Carbo MCP - Keycloak administrator" "carbo-admin" "$KC_ADMIN_PW" "http://100.71.174.8:8111/admin/" \
"Keycloak master-realm administrator for the MCP gateway.

Admin console is TAILNET ONLY - http://100.71.174.8:8111/admin/ - and
returns 404 over the public hostname by design.

Use it to add or disable MCP users, revoke the Claude connector, or end
sessions. Source: /opt/carbo-mcp/secrets/keycloak_admin_password."

mkitem "Carbo MCP - Keycloak PostgreSQL" "keycloak" "$KC_DB_PW" "" \
"Database 'keycloak' on container carbo-keycloak-db.

No host port is published; reachable only on the carbo-mcp-internal
Docker network, which has no route off the host.

The file must stay mode 0640 group gid 1000 - Compose bind-mounts secret
files verbatim, and Keycloak's container uid must be able to read it.
Source: /opt/carbo-mcp/secrets/keycloak_db_password."

mkitem "Carbo MCP - Claude connector client secret" "claude-ai-connector" "$CONNECTOR_SECRET" "https://mcp.carbocomputers.com" \
"OAuth client secret for the statically configured Claude.ai connector.

Normally unused: Claude registers itself dynamically. Needed only if
Claude's UI asks for a Client ID and Secret.
Source: /opt/carbo-mcp/secrets/claude_connector_client_secret."

mkitem "Carbo MCP - Carbo Design API token (read-only)" "carbo-mcp-gateway (read-only)" "$DESIGN_TOKEN" "https://design.carbo.lan" \
"Lets the MCP gateway read Carbo Design. Holds ONLY the six read scopes:
projects, components, publish, sites, assets, audit.

Writes are refused by Carbo Design itself - POST /api/projects returns 403.
Revoke it in Carbo Design (admin -> tokens) if ever needed.
Source: /opt/carbo-mcp/secrets/carbo_design_api_token."

mkitem "Carbo MCP - Uptime Kuma API key" "carbo-mcp-gateway" "$KUMA_KEY" "http://100.69.59.37" \
"Read-only metrics key for Uptime Kuma on the AWS EC2 box (tailnet only).

Used for HTTP Basic on /metrics with an EMPTY username and the key as the
password. Uptime Kuma shows a key once at creation and stores only a hash,
so this vault entry is the only copy.
Source: /opt/carbo-mcp/secrets/uptime_kuma_api_key."

echo
echo "created: $created  updated: $updated  skipped: $skipped"
echo "No secret value was printed by this script."
