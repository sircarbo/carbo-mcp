#!/usr/bin/env bash
#
# Configures the `carbo` realm for the MCP gateway.
#
# Idempotent: every object is looked up before it is created, so this can be
# re-run after an upgrade or a restore without duplicating anything.
#
# What it builds:
#   * a realm, `carbo`, separate from `master` so the admin account and the
#     MCP users are never the same population;
#   * one client scope per gateway permission, so the scopes the gateway
#     enforces exist as real, consentable OAuth scopes rather than being
#     implied;
#   * an audience mapper pinning `aud` to the gateway's resource identifier --
#     this is what makes a token minted for anything else useless here;
#   * a confidential client for the Claude.ai connector, with PKCE required;
#   * dynamic client registration limited to Claude's own redirect hosts, so
#     the connector can self-register but nobody else can;
#   * a login user.
#
# No secret is echoed. Generated passwords are written to ./secrets/ with
# restrictive permissions and referred to by path only.
set -euo pipefail

REALM="${CARBO_KEYCLOAK_REALM:-carbo}"
CONTAINER="${CARBO_KEYCLOAK_CONTAINER:-carbo-keycloak}"
RESOURCE="${CARBO_MCP_RESOURCE:-https://mcp.carbocomputers.com/mcp}"
CLIENT_ID="claude-ai-connector"
LOGIN_USER="${CARBO_MCP_USER:-carbo}"
SECRETS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/secrets"

SCOPES=(
  "carbo:server:read|Read server health and resource usage"
  "carbo:docker:read|Read Docker container status"
  "carbo:video:read|Read Video Factory job status"
  "carbo:n8n:read|Read n8n workflows and executions"
  "carbo:websites:read|Read managed website status"
  "carbo:backups:read|Read backup freshness"
  "carbo:projects:read|Read project repository status"
  "carbo:audit:read|Read the MCP gateway audit summary"
  "carbo:design:read|Read Carbo Design projects, components and publications"
  "carbo:monitoring:read|Read Uptime Kuma monitor status"
)

# Claude's connector callback. Registration is restricted to these hosts.
CLAUDE_REDIRECTS='["https://claude.ai/api/mcp/auth_callback","https://claude.com/api/mcp/auth_callback"]'

kc() { docker exec -i "$CONTAINER" /opt/keycloak/bin/kcadm.sh "$@"; }

log() { printf '  %s\n' "$*" >&2; }

# ---------------------------------------------------------------- authenticate

log "authenticating to Keycloak admin API"
docker exec -i "$CONTAINER" /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://127.0.0.1:8080 \
  --realm master \
  --user carbo-admin \
  --password "$(cat "$SECRETS_DIR/keycloak_admin_password")" >/dev/null

# --------------------------------------------------------------------- realm

if kc get "realms/$REALM" >/dev/null 2>&1; then
  log "realm '$REALM' already exists"
else
  log "creating realm '$REALM'"
  kc create realms \
    -s "realm=$REALM" \
    -s enabled=true \
    -s displayName="Carbo MCP" \
    -s sslRequired=external \
    -s registrationAllowed=false \
    -s bruteForceProtected=true \
    -s permanentLockout=false \
    -s maxFailureWaitSeconds=900 \
    -s failureFactor=5 \
    -s 'accessTokenLifespan=900' \
    -s 'ssoSessionIdleTimeout=3600' \
    -s 'ssoSessionMaxLifespan=36000' >/dev/null
fi

# -------------------------------------------------------------- client scopes

# Values reach python through the environment, never by interpolating into its
# source -- a scope name containing a quote would otherwise break the script.
scope_id() {
  kc get client-scopes -r "$REALM" --fields id,name --format json 2>/dev/null \
    | SCOPE_NAME="$1" python3 -c '
import os, sys, json
want = os.environ["SCOPE_NAME"]
try:
    data = json.load(sys.stdin)
except Exception:
    data = []
for item in data:
    if item.get("name") == want:
        print(item["id"])
        break
'
}

ensure_scope() {
  local name="$1" description="$2" existing
  existing="$(scope_id "$name")"
  if [[ -n "$existing" ]]; then
    log "client scope '$name' already exists"
    printf '%s' "$existing"
    return
  fi
  log "creating client scope '$name'"
  kc create client-scopes -r "$REALM" \
    -s "name=$name" \
    -s "description=$description" \
    -s protocol=openid-connect \
    -s 'attributes."include.in.token.scope"=true' \
    -s 'attributes."display.on.consent.screen"=true' \
    -s 'attributes."consent.screen.text"='"$description" >/dev/null
  printf '%s' "$(scope_id "$name")"
}

# The audience mapper is attached to every read scope, not only to a dedicated
# audience scope. This matters because Keycloak's *dynamic* client registration
# does not apply realm default client scopes the way normal client creation
# does: when the registration request names the scopes it wants, Keycloak files
# those as OPTIONAL and reduces the client's defaults to just `basic`. A
# standalone audience scope is therefore dropped -- the client never asks for it,
# because it is not an advertised scope -- and every token arrives without the
# gateway in `aud`.
#
# Binding the audience to the read scopes makes the rule self-consistent: if a
# token grants you a Carbo read scope, it is addressed to the Carbo gateway.
ensure_audience_mapper() {
  local scope_id="$1" scope_name="$2" present
  if [[ -z "$scope_id" ]]; then
    log "  no id resolved for '$scope_name'; skipping its audience mapper"
    return 0
  fi

  present="$(kc get "client-scopes/$scope_id/protocol-mappers/models" -r "$REALM" --format json 2>/dev/null \
    | python3 -c '
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    data = []
print("yes" if any(m.get("name") == "carbo-mcp-audience-mapper" for m in data) else "no")
' 2>/dev/null || true)"

  if [[ "$present" == "yes" ]]; then
    return 0
  fi

  log "adding audience mapper to '$scope_name'"
  # A mapper that already exists must not abort the run: this script is meant to
  # be re-runnable after an upgrade or a restore.
  if ! kc create "client-scopes/$scope_id/protocol-mappers/models" -r "$REALM" -f - >/dev/null 2>&1 <<JSON
{
  "name": "carbo-mcp-audience-mapper",
  "protocol": "openid-connect",
  "protocolMapper": "oidc-audience-mapper",
  "config": {
    "included.custom.audience": "$RESOURCE",
    "access.token.claim": "true",
    "id.token.claim": "false",
    "introspection.token.claim": "true"
  }
}
JSON
  then
    log "  audience mapper already present on '$scope_name'"
  fi
}

declare -a SCOPE_IDS=()
for entry in "${SCOPES[@]}"; do
  scope_name="${entry%%|*}"
  sid="$(ensure_scope "$scope_name" "${entry#*|}")"
  SCOPE_IDS+=("$sid")
  ensure_audience_mapper "$sid" "$scope_name"
done

# The audience scope is what binds a token to this specific resource.
AUDIENCE_SCOPE_ID="$(ensure_scope "carbo-mcp-audience" "Bind the token to the Carbo MCP Gateway")"

# The dedicated audience scope keeps the same mapper, for statically configured
# clients that hold it as a default scope.
ensure_audience_mapper "$AUDIENCE_SCOPE_ID" "carbo-mcp-audience"

# Realm-wide defaults, so a dynamically registered client gets the same scopes
# and the same audience as the statically configured one.
for sid in "${SCOPE_IDS[@]}" "$AUDIENCE_SCOPE_ID"; do
  kc update "default-default-client-scopes/$sid" -r "$REALM" >/dev/null 2>&1 || true
done
log "scopes registered as realm defaults"

# --------------------------------------------------------------------- client

client_uuid() {
  kc get clients -r "$REALM" -q "clientId=$CLIENT_ID" --fields id --format json 2>/dev/null \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['id'] if d else '')"
}

CLIENT_UUID="$(client_uuid)"
if [[ -n "$CLIENT_UUID" ]]; then
  log "client '$CLIENT_ID' already exists"
else
  log "creating confidential client '$CLIENT_ID'"
  kc create clients -r "$REALM" -f - <<JSON >/dev/null
{
  "clientId": "$CLIENT_ID",
  "name": "Claude.ai remote connector",
  "description": "Claude.ai custom connector for the Carbo MCP Gateway",
  "enabled": true,
  "protocol": "openid-connect",
  "publicClient": false,
  "standardFlowEnabled": true,
  "implicitFlowEnabled": false,
  "directAccessGrantsEnabled": false,
  "serviceAccountsEnabled": false,
  "consentRequired": true,
  "redirectUris": $CLAUDE_REDIRECTS,
  "webOrigins": ["https://claude.ai", "https://claude.com"],
  "attributes": {
    "pkce.code.challenge.method": "S256",
    "client.secret.creation.time": "0",
    "access.token.lifespan": "900",
    "post.logout.redirect.uris": "+"
  }
}
JSON
  CLIENT_UUID="$(client_uuid)"
fi

# Store the client secret as a file. It is never printed.
if [[ -n "$CLIENT_UUID" ]]; then
  umask 077
  kc get "clients/$CLIENT_UUID/client-secret" -r "$REALM" --fields value --format json \
    | python3 -c "import sys,json;sys.stdout.write(json.load(sys.stdin)['value'])" \
    > "$SECRETS_DIR/claude_connector_client_secret"
  chmod 600 "$SECRETS_DIR/claude_connector_client_secret"
  log "client secret written to secrets/claude_connector_client_secret (not displayed)"
fi

# ------------------------------------------------- dynamic client registration

# Claude.ai prefers to register itself. Allowing that unconditionally would let
# anyone create a client in this realm, so the trusted-hosts policy is pinned to
# Claude's own callback hosts: self-registration works, and a client claiming
# any other redirect URI is refused.
POLICY_ID="$(kc get components -r "$REALM" \
  -q 'type=org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy' \
  --format json 2>/dev/null \
  | python3 -c "
import sys, json
for c in json.load(sys.stdin):
    if c.get('providerId') == 'trusted-hosts' and c.get('subType') == 'anonymous':
        print(c['id']); break
" || true)"

if [[ -n "$POLICY_ID" ]]; then
  log "restricting anonymous client registration to Claude's callback hosts"
  kc update "components/$POLICY_ID" -r "$REALM" -f - <<'JSON' >/dev/null
{
  "name": "Trusted Hosts",
  "providerId": "trusted-hosts",
  "providerType": "org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy",
  "subType": "anonymous",
  "config": {
    "trusted-hosts": ["claude.ai", "claude.com"],
    "host-sending-registration-request-must-match": ["false"],
    "client-uris-must-match": ["true"]
  }
}
JSON
else
  log "WARNING: trusted-hosts policy not found; dynamic registration left at defaults"
fi

# ----------------------------------------------------------------------- user

user_id() {
  kc get users -r "$REALM" -q "username=$LOGIN_USER" --fields id --format json 2>/dev/null \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['id'] if d else '')"
}

if [[ -n "$(user_id)" ]]; then
  log "user '$LOGIN_USER' already exists"
else
  log "creating user '$LOGIN_USER'"
  kc create users -r "$REALM" \
    -s "username=$LOGIN_USER" \
    -s enabled=true \
    -s emailVerified=true >/dev/null

  umask 077
  LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 28 > "$SECRETS_DIR/keycloak_user_password"
  chmod 600 "$SECRETS_DIR/keycloak_user_password"
  kc set-password -r "$REALM" --username "$LOGIN_USER" \
    --new-password "$(cat "$SECRETS_DIR/keycloak_user_password")" >/dev/null
  log "user password written to secrets/keycloak_user_password (not displayed)"
fi

# ---------------------------------------------------- repair existing clients

# Clients registered before the audience mapper moved onto the read scopes hold
# neither the audience scope nor a mapper. Attaching the audience scope as a
# default repairs them in place, so an already-connected Claude.ai connector
# starts working again without being removed and re-added.
log "repairing any client that can read but is not addressed to this resource"
kc get clients -r "$REALM" --fields id,clientId,defaultClientScopes,optionalClientScopes --format json 2>/dev/null \
  | python3 -c "
import sys, json
for c in json.load(sys.stdin):
    scopes = set(c.get('defaultClientScopes') or []) | set(c.get('optionalClientScopes') or [])
    if any(s.startswith('carbo:') for s in scopes) and 'carbo-mcp-audience' not in scopes:
        print(c['id'])
" | while read -r cid; do
  [[ -z "$cid" ]] && continue
  log "  attaching carbo-mcp-audience to client $cid"
  kc update "clients/$cid/default-client-scopes/$AUDIENCE_SCOPE_ID" -r "$REALM" >/dev/null 2>&1 || true
done

# A client that registered before a scope existed has no way to request it --
# dynamic registration fixes a client's scope list at registration time. Attach
# any missing read scope as optional so an existing connector can pick it up on
# its next authorization, without being removed and re-added.
log "ensuring every client with read scopes can request all of them"
kc get clients -r "$REALM" --fields id,clientId,defaultClientScopes,optionalClientScopes --format json 2>/dev/null \
  | python3 -c "
import sys, json
for c in json.load(sys.stdin):
    scopes = set(c.get('defaultClientScopes') or []) | set(c.get('optionalClientScopes') or [])
    if any(s.startswith('carbo:') for s in scopes):
        print(c['id'], ' '.join(sorted(scopes)))
" | while read -r cid held; do
  [[ -z "$cid" ]] && continue
  for entry in "${SCOPES[@]}"; do
    name="${entry%%|*}"
    if [[ " $held " != *" $name "* ]]; then
      sid="$(scope_id "$name")"
      [[ -z "$sid" ]] && continue
      log "  adding $name to client $cid"
      kc update "clients/$cid/optional-client-scopes/$sid" -r "$REALM" >/dev/null 2>&1 || true
    fi
  done
done

log "done"
