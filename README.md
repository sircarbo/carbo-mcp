# Carbo MCP Gateway

A read-only Model Context Protocol gateway that lets Claude.ai see the state of
**carbo-server** — system resources, containers, service and website health, n8n
automations, Video Factory jobs, backups, project repositories, error summaries,
Carbo Design's component system, Uptime Kuma monitoring, and the gateway's own
audit trail.

**Public endpoint:** `https://mcp.carbocomputers.com/mcp`
**Project root:** `/opt/carbo-mcp`
**Status:** deployed and verified 2026-09-05

---

## What it is

Twenty-one tools, all Level 1 (read-only), all requiring OAuth 2.1 authentication
against a Keycloak realm running on this server. Nothing in this gateway can
start, stop, restart, deploy, publish, send, delete, or execute anything. There
is no shell, no terminal, no file browser, no SQL console, and no Docker socket
anywhere in the request path.

## How it fits together

```
Claude.ai
  │  HTTPS 443
  ▼
nginx + Let's Encrypt  ── Linode VPS 76.13.113.165 (the public edge)
  │  Tailscale 100.94.212.114 → 100.71.174.8
  ▼
carbo-server
  ├─ carbo-mcp       100.71.174.8:8110   distroless, read-only, no capabilities
  ├─ carbo-keycloak  100.71.174.8:8111   OAuth 2.1 authorization server
  └─ carbo-keycloak-db                   internal network only, no published port
        ▲
        │ reads sanitized JSON snapshots (read-only mount)
  carbo-mcp-collector.timer  ── the one privileged piece, on the host, not in a container
```

carbo-server sits on a residential connection with UFW denying inbound 80/443,
so the VPS is the only way in. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for why the collector exists and what that split buys.

## Quick start

```bash
cd /opt/carbo-mcp
make help        # every available command
make health      # container, internal, public and auth-boundary checks
make status      # stack status
make audit       # recent audit events
make test        # 151 automated tests
```

## Connecting Claude.ai

Full walkthrough in [docs/CLAUDE_AI_CONNECTION.md](docs/CLAUDE_AI_CONNECTION.md).
The short version: add a custom connector in Claude.ai pointing at
`https://mcp.carbocomputers.com/mcp`, sign in as `carbo` when the browser
window opens, and approve the eight read scopes.

## Documentation

| Document | What it covers |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Design, the collector split, language choice, data flow |
| [SERVICE_INVENTORY.md](docs/SERVICE_INVENTORY.md) | Everything discovered on the server and how it was classified |
| [TOOLS.md](docs/TOOLS.md) | All fifteen tools, their scopes and limits; deferred capabilities |
| [SECURITY.md](docs/SECURITY.md) | Threat model, hardening, exclusions, scanning |
| [AUTHENTICATION.md](docs/AUTHENTICATION.md) | Keycloak realm, scopes, token validation, user management |
| [NGINX_PROXY_MANAGER.md](docs/NGINX_PROXY_MANAGER.md) | Reverse proxy config, plus NPM-equivalent values |
| [CLAUDE_AI_CONNECTION.md](docs/CLAUDE_AI_CONNECTION.md) | Connecting, testing, revoking |
| [OPERATIONS.md](docs/OPERATIONS.md) | Day-to-day running, backups, upgrades |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptoms and fixes |
| [ROLLBACK.md](docs/ROLLBACK.md) | Undoing a deployment, and full removal |
| [CHANGELOG.md](docs/CHANGELOG.md) | What changed and when |

## Layout

```
/opt/carbo-mcp
├── docker-compose.yml       three services, digest-pinned, tailnet-bound
├── Dockerfile               multi-stage → distroless runtime
├── Dockerfile.keycloak      Keycloak pre-built for Postgres
├── Makefile                 operations, scoped to this stack only
├── .env                     compose settings (no secrets)
├── config/gateway.env       gateway runtime settings (no secrets)
├── secrets/                 0700; credentials as files, never in compose or git
├── data/snapshots/          collector output, mounted read-only into the gateway
├── data/audit/              audit log, the only writable mount
├── scripts/                 collector, Keycloak setup, health check, rollback
├── src/                     TypeScript gateway
├── tests/                   151 tests
└── docs/                    the table above
```

## Safety properties

- The gateway container runs as uid 65532 with a read-only root filesystem, all
  Linux capabilities dropped, `no-new-privileges`, and a distroless base with no
  shell and no package manager.
- No Docker socket is mounted anywhere in the stack.
- Neither published port binds `0.0.0.0` — both bind the Tailscale address.
- The Postgres instance has no published port at all and sits on an `internal`
  Docker network with no route off the host.
- Secrets exist only as mode-0640 files under `secrets/`, never in
  `docker-compose.yml`, the Dockerfile, the images, this documentation, or git.
- Vaultwarden, wetty, SSH, all databases, and the Samba shares are excluded from
  every tool at every level. See [SECURITY.md](docs/SECURITY.md).
