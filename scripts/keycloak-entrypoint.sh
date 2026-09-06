#!/bin/bash
#
# Loads Keycloak's credentials from Docker secret files.
#
# Keycloak 26 has no generic KC_<OPTION>_FILE support -- passing
# KC_DB_PASSWORD_FILE is silently ignored, which is how this deployment first
# came up with no database password at all. The credentials therefore have to
# reach Keycloak as environment variables, and this wrapper is what puts them
# there: they live as 0600 files on the host, never in docker-compose.yml, the
# Dockerfile, the image, or version control.
set -euo pipefail

load_secret() {
  local var="$1" path="$2"
  if [[ -r "$path" ]]; then
    export "$var=$(< "$path")"
  fi
}

load_secret KC_DB_PASSWORD /run/secrets/keycloak_db_password
load_secret KC_BOOTSTRAP_ADMIN_PASSWORD /run/secrets/keycloak_admin_password

exec /opt/keycloak/bin/kc.sh "$@"
