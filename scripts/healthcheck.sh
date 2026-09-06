#!/usr/bin/env bash
#
# Health check for the whole path: container -> internal endpoint -> public
# HTTPS -> auth boundary. Read-only; it never mutates anything.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

BIND=$(grep -E '^CARBO_MCP_BIND_ADDR=' .env | cut -d= -f2)
PORT=$(grep -E '^CARBO_MCP_PORT=' .env | cut -d= -f2)
PUBLIC=$(grep -E '^CARBO_MCP_PUBLIC_ORIGIN=' .env | cut -d= -f2)
REALM=$(grep -E '^CARBO_KEYCLOAK_REALM=' .env | cut -d= -f2)

fail=0
check() { # label expected actual
  if [[ "$2" == "$3" ]]; then printf '  ok    %-46s %s\n' "$1" "$3"
  else printf '  FAIL  %-46s got %s, want %s\n' "$1" "$3" "$2"; fail=1; fi
}
code() { curl -s -o /dev/null -w '%{http_code}' -m 15 "$@"; }

echo "-- containers --"
for c in carbo-mcp carbo-keycloak carbo-keycloak-db; do
  state=$(docker inspect "$c" --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo "absent")
  printf '  %-22s %s\n' "$c" "$state"
  [[ "$state" == running/* ]] || fail=1
done

echo "-- internal --"
check "/health"  200 "$(code "http://$BIND:$PORT/health")"
check "/ready"   200 "$(code "http://$BIND:$PORT/ready")"

echo "-- public --"
check "GET /health"                        200 "$(code "$PUBLIC/health")"
check "protected resource metadata"        200 "$(code "$PUBLIC/.well-known/oauth-protected-resource/mcp")"
check "authorization server metadata"      200 "$(code "$PUBLIC/.well-known/oauth-authorization-server/realms/$REALM")"
check "GET /mcp is refused"                405 "$(code "$PUBLIC/mcp")"
check "unknown path is a bare 404"         404 "$(code "$PUBLIC/")"
check "Keycloak admin console not public"  404 "$(code "$PUBLIC/admin/master/console/")"

echo "-- auth boundary --"
BODY='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
HDRS=(-H 'content-type: application/json' -H 'accept: application/json, text/event-stream')
check "POST /mcp with no token"      401 "$(code -X POST "$PUBLIC/mcp" "${HDRS[@]}" -d "$BODY")"
check "POST /mcp with a bad token"   401 "$(code -X POST "$PUBLIC/mcp" "${HDRS[@]}" -H 'authorization: Bearer not.a.token' -d "$BODY")"

echo "-- collector --"
result=$(systemctl show carbo-mcp-collector.service -p Result --value 2>/dev/null)
active=$(systemctl is-active carbo-mcp-collector.timer 2>/dev/null)
printf '  %-52s %s\n' "timer" "$active"
printf '  %-52s %s\n' "last run" "$result"
[[ "$active" == "active" && "$result" == "success" ]] || fail=1

echo
if [[ $fail -eq 0 ]]; then echo "All checks passed."; else echo "One or more checks FAILED."; fi
exit $fail
