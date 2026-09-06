# Carbo MCP Gateway -- operations.
#
# Every target is scoped to this stack by name. None of them can touch the 29
# unrelated containers on this host: compose is always invoked with this
# project's file and project name, and nothing here ever runs a bare
# `docker restart`, `docker system prune`, or `docker compose down` without an
# explicit service list.

SHELL := /bin/bash
.DEFAULT_GOAL := help

COMPOSE  := docker compose --env-file .env
SERVICES := carbo-mcp carbo-keycloak carbo-keycloak-db
GATEWAY  := carbo-mcp
BIND     := $(shell grep -E '^CARBO_MCP_BIND_ADDR=' .env | cut -d= -f2)
PORT     := $(shell grep -E '^CARBO_MCP_PORT=' .env | cut -d= -f2)
PUBLIC   := $(shell grep -E '^CARBO_MCP_PUBLIC_ORIGIN=' .env | cut -d= -f2)
STAMP    := $(shell date +%Y%m%d-%H%M%S)

.PHONY: help
help: ## Show this help
	@echo "Carbo MCP Gateway -- operations"; echo
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "  Public URL: $(PUBLIC)/mcp"
	@echo "  Internal:   http://$(BIND):$(PORT)"

# ----------------------------------------------------------------- lifecycle

.PHONY: build
build: ## Build the gateway and Keycloak images
	$(COMPOSE) build

.PHONY: start
start: ## Start the MCP stack (this stack only)
	$(COMPOSE) up -d $(SERVICES)

.PHONY: stop
stop: ## Stop the MCP stack, leaving every other container running
	$(COMPOSE) stop $(SERVICES)

.PHONY: restart
restart: ## Restart the MCP stack only
	$(COMPOSE) restart $(SERVICES)

.PHONY: restart-gateway
restart-gateway: ## Restart only the gateway, leaving Keycloak up
	$(COMPOSE) restart $(GATEWAY)

.PHONY: deploy
deploy: validate test build ## Validate, test, build, then roll out the gateway
	$(COMPOSE) up -d $(SERVICES)
	@$(MAKE) --no-print-directory health

# -------------------------------------------------------------------- status

.PHONY: status
status: ## Show stack status
	@$(COMPOSE) ps
	@echo; echo "Collector timer:"; systemctl status carbo-mcp-collector.timer --no-pager 2>/dev/null | head -4 || true

.PHONY: health
health: ## Check container, internal, public and auth-boundary health
	@bash scripts/healthcheck.sh

.PHONY: logs
logs: ## Tail sanitized gateway logs
	$(COMPOSE) logs -f --tail 100 $(GATEWAY)

.PHONY: logs-keycloak
logs-keycloak: ## Tail Keycloak logs
	$(COMPOSE) logs -f --tail 100 carbo-keycloak

.PHONY: audit
audit: ## Show the most recent audit events
	@sudo python3 scripts/show-audit.py 40

.PHONY: collect
collect: ## Refresh host snapshots now
	sudo systemctl start carbo-mcp-collector.service
	@sleep 3; systemctl show carbo-mcp-collector.service -p Result --value

# --------------------------------------------------------------------- checks

.PHONY: validate
validate: ## Validate compose, config, secrets and dependencies
	@echo "-- compose --"; $(COMPOSE) config --quiet && echo "  compose file valid"
	@echo "-- required files --"
	@for f in Dockerfile Dockerfile.keycloak config/gateway.env .env scripts/collector.py; do \
	  [ -f "$$f" ] && echo "  ok   $$f" || { echo "  MISSING $$f"; exit 1; }; done
	@echo "-- secrets present and not world-readable --"
	@for f in secrets/keycloak_db_password secrets/keycloak_admin_password; do \
	  [ -s "$$f" ] || { echo "  MISSING or empty $$f"; exit 1; }; \
	  perm=$$(stat -c %a "$$f"); \
	  case "$$perm" in *[2367]) echo "  WORLD-READABLE $$f ($$perm)"; exit 1;; *) echo "  ok   $$f ($$perm)";; esac; done
	@echo "-- no secret material committed or embedded --"
	@if grep -rInE '(password|secret|api[_-]?key)[[:space:]]*[=:][[:space:]]*[A-Za-z0-9+/_-]{12,}' \
	     docker-compose.yml Dockerfile Dockerfile.keycloak config/ src/ docs/ 2>/dev/null \
	     | grep -v 'redacted\|_FILE\|PASSWORD_FILE\|example\|<'; then \
	  echo "  FAIL: literal-looking credential found above"; exit 1; \
	else echo "  ok   no literal credentials in tracked files"; fi
	@echo "-- port availability --"
	@ss -tlnp 2>/dev/null | grep -q "$(BIND):$(PORT) " && echo "  ok   $(BIND):$(PORT) held by this stack" || echo "  note $(BIND):$(PORT) not currently bound"

.PHONY: test
test: ## Run the automated test suite
	@export NVM_DIR="$$HOME/.nvm"; . "$$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use 22 >/dev/null 2>&1; \
	  npx tsc -p tsconfig.json --noEmit && npx vitest run

.PHONY: scan
scan: ## Scan images and dependencies for known vulnerabilities
	@echo "-- npm audit (production dependencies) --"
	@export NVM_DIR="$$HOME/.nvm"; . "$$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use 22 >/dev/null 2>&1; \
	  npm audit --omit=dev || true
	@echo; echo "-- container image scan --"
	@if command -v trivy >/dev/null 2>&1; then \
	  trivy image --severity HIGH,CRITICAL --ignore-unfixed carbo-mcp-gateway:1.0.0; \
	  trivy image --severity HIGH,CRITICAL --ignore-unfixed carbo-keycloak:26.7.3; \
	else \
	  echo "  trivy not installed. To scan without installing anything permanently:"; \
	  echo "    docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \\"; \
	  echo "      aquasec/trivy:latest image --severity HIGH,CRITICAL carbo-mcp-gateway:1.0.0"; \
	  echo "  (that container needs the Docker socket; the gateway itself never does)"; \
	fi

# -------------------------------------------------------------- backup/restore

.PHONY: backup
backup: ## Back up configuration, secrets and the Keycloak realm
	@mkdir -p backups
	@$(COMPOSE) exec -T carbo-keycloak-db pg_dump -U keycloak keycloak \
	  | gzip > backups/keycloak-db-$(STAMP).sql.gz
	@tar --exclude=node_modules --exclude=dist --exclude=backups --exclude=data/snapshots \
	   -czf backups/carbo-mcp-config-$(STAMP).tar.gz \
	   docker-compose.yml Dockerfile Dockerfile.keycloak .env config scripts src tests \
	   package.json package-lock.json tsconfig.json Makefile docs 2>/dev/null
	@umask 077; tar -czf backups/carbo-mcp-secrets-$(STAMP).tar.gz secrets
	@chmod 600 backups/carbo-mcp-secrets-$(STAMP).tar.gz
	@echo "Wrote:"; ls -1 backups/*$(STAMP)* | sed 's/^/  /'
	@echo "  (the secrets archive is mode 600 -- keep it that way)"

.PHONY: rollback
rollback: ## Roll the gateway back to the previous image
	@bash scripts/rollback.sh

# ---------------------------------------------------------------------- setup

.PHONY: configure-keycloak
configure-keycloak: ## Re-apply the Keycloak realm configuration (idempotent)
	bash scripts/configure-keycloak.sh
