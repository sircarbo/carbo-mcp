#!/usr/bin/env bash
#
# Rolls the gateway back to the previously built image.
#
# Scoped to the gateway container alone: Keycloak, its database, and every
# other container on this host are left exactly as they are. If no previous
# image exists the script stops rather than guessing.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

CURRENT_TAG="carbo-mcp-gateway:1.0.0"
PREVIOUS_TAG="carbo-mcp-gateway:previous"

if ! docker image inspect "$PREVIOUS_TAG" >/dev/null 2>&1; then
  cat <<MSG
No image tagged '$PREVIOUS_TAG' exists, so there is nothing to roll back to.

Tag a known-good image before your next deploy:
    docker tag $CURRENT_TAG $PREVIOUS_TAG

To roll back the whole stack instead, restore from a backup:
    docs/ROLLBACK.md
MSG
  exit 1
fi

echo "Rolling the gateway back to $PREVIOUS_TAG"
docker tag "$CURRENT_TAG" "carbo-mcp-gateway:rolled-back-$(date +%Y%m%d-%H%M%S)"
docker tag "$PREVIOUS_TAG" "$CURRENT_TAG"

# Only the gateway is recreated. Keycloak keeps its sessions and its database.
docker compose --env-file .env up -d --force-recreate --no-deps carbo-mcp

echo "Waiting for health..."
for _ in $(seq 1 20); do
  status="$(docker inspect carbo-mcp --format '{{.State.Health.Status}}' 2>/dev/null || echo unknown)"
  echo "  $status"
  [[ "$status" == "healthy" ]] && { echo "Rollback complete."; exit 0; }
  sleep 5
done

echo "Gateway did not become healthy. Check: docker logs carbo-mcp" >&2
exit 1
