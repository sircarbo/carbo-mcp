# CLAUDE.md — MCPGW (Carbo MCP Gateway)
# Location: /opt/carbo-mcp/CLAUDE.md
# Last Updated: 2026-09-05

---

## NOT TO BE CONFUSED WITH CARBO DESIGN

There are two things on this server with "MCP" in the name. They are unrelated.

| | **MCPGW** (this project) `/opt/carbo-mcp` | **DESIGN** `/opt/carbo-design` |
|---|---|---|
| What it is | Read-only observability gateway | Visual component / design system (GrapesJS studio, WordPress plugin) |
| Its README title | "Carbo MCP Gateway" | "Carbo Design MCP" ← the source of the confusion |
| MCP tools | 22, all read-only server facts | 34, for creating and editing components |
| Container | `carbo-mcp` | `carbo-design-mcp`, `carbo-design-api`, `carbo-design-studio` |
| Reachable from | The public internet, via Claude.ai | Loopback only (`127.0.0.1:8101-8104`) |
| Touches images or design | Only the opt-in Kling tools, which animate an *existing* image (`docs/KLING.md`) | Yes — that is its whole job |

If the question is about images, components, templates, GrapesJS, or publishing to
WordPress, it is **DESIGN**, not this project.

In `/home/sircarbo/CLAUDE.md` these are the aliases **MCPGW** (this project) and
**DESIGN**. `start project MCPGW` loads this file.

---

## WHAT THIS PROJECT DOES

Lets Claude.ai see the state of carbo-server: system resources, Docker container
status, service and website health, n8n workflows and executions, Video Factory
job status, backup freshness, project repository status, sanitized error
summaries, Carbo Design's component system, Uptime Kuma monitoring, and this
gateway's own audit trail.

Twenty-two tools. All read-only. Nothing here can start, stop, restart, deploy,
publish, send, delete, or execute anything. (`carbo_get_terminal_status`, added
2026-09-11, reports the wetty terminal's liveness and link; it cannot open it.)

Plus three **opt-in Level 3** tools (`kling_*`, added 2026-09-11) that submit
paid Kling AI image-to-video jobs. They exist only when a credential file and
`MCP_ELEVATED_TOOLS` are configured via `docker-compose.kling.yml`; the default
deployment does not have them. See `docs/KLING.md`.

**Public endpoint:** `https://mcp.carbocomputers.com/mcp`

---

## ARCHITECTURE IN ONE PICTURE

```
Claude.ai
  │ HTTPS 443
  ▼
nginx + Let's Encrypt  ── Linode VPS 76.13.113.165  (the ONLY public entrance)
  │ Tailscale 100.94.212.114 → 100.71.174.8
  ▼
carbo-server
  ├─ carbo-mcp        100.71.174.8:8110   distroless, read-only, no capabilities
  ├─ carbo-keycloak   100.71.174.8:8111   OAuth 2.1 authorization server
  └─ carbo-keycloak-db                    internal network only, no published port
        ▲
        │ reads sanitized JSON snapshots (read-only mount)
  carbo-mcp-collector.timer  ── privileged, on the HOST, every 2 minutes
```

**The load-bearing decision:** the container that faces the internet has no
Docker socket, no host filesystem, no database credentials and no shell. A small
root-run collector on the host gathers the facts, sanitizes them, and writes JSON
that the container reads read-only. Do not "simplify" this by mounting the Docker
socket — the split is the security model.

---

## FACTS THAT ARE EASY TO GET WRONG

- `mcp.carbocomputers.com` resolves to **76.13.113.165 (the Linode VPS)**, not to
  carbo-server. carbo-server is residential and UFW denies inbound 80/443.
- **There is no Nginx Proxy Manager anywhere.** The reverse proxy is stock nginx
  1.24 + Certbot on the VPS, edited as files in `/etc/nginx/sites-available/`.
- nginx 1.24 predates `http2 on;` — use `listen 443 ssl http2;`.
- Keycloak is served on the **same hostname** under `/realms/`, because only one
  DNS record exists. Its admin console is tailnet-only and returns 404 publicly.
- Keycloak 26 ignores `KC_<OPTION>_FILE`. Secrets reach it via
  `scripts/keycloak-entrypoint.sh`.
- Compose bind-mounts secret files **verbatim**, so Keycloak's two secrets must
  stay mode 0640 group gid 1000 or the container cannot read them.
- Keycloak's **dynamic** client registration does not apply realm default client
  scopes. That is why the audience mapper lives on each `carbo:*:read` scope, not
  only on a dedicated audience scope. Do not undo this.
- The 400 Claude gets on connect is a protocol-version probe. It is expected and
  harmless; Claude negotiates down immediately.

---

## COMMANDS

```bash
cd /opt/carbo-mcp

make help              # every target
make health            # containers, internal, public, auth boundary, collector
make status            # stack status
make audit             # recent audit events
make test              # 151 tests
make validate          # compose, files, secret permissions, no leaked credentials
make logs              # sanitized gateway logs
make collect           # refresh host snapshots now

make deploy            # validate → test → build → roll out → health check
make stop              # THIS STACK ONLY
make restart-gateway   # gateway only; Keycloak keeps its sessions
make backup            # config + secrets + Keycloak realm
make rollback          # revert the gateway to the previous image
make configure-keycloak  # idempotent realm setup
```

Every target is scoped to this stack. None of them can affect the 29 unrelated
containers on this host.

---

## SAFETY RULES SPECIFIC TO THIS PROJECT

These are on top of the global rules in `/home/sircarbo/CLAUDE.md`.

- **Never mount `/var/run/docker.sock`** into the gateway container. The host
  collector exists precisely so this is unnecessary.
- **Never add a Level 4 tool, and never enable a Level 3 tool by default.**
  `ToolRegistry.register()` throws for any tool above risk level 1 unless its
  name is in the explicit `MCP_ELEVATED_TOOLS` allowlist, and throws for Level 4
  regardless; tests assert both. The only Level 3 tools are the three `kling_*`
  ones. Adding another elevated tool means adding its name to the config enum,
  a scope, docs, and tests — not loosening the guard.
- **Kling jobs cost money.** `kling_animate_image` submits exactly one job per
  call and never retries. Do not submit one during testing without Carbo's
  explicit say-so; use `dry_run: true`.
- **Never expose** Vaultwarden, wetty/ttyd, SSH, any SQL console, raw command
  execution, filesystem browsing, or Samba shares. Hard exclusions, any level.
- **Never weaken audience, issuer, or signature validation** to make something
  work. If a token is refused, fix the token's issuance, not the check.
- **Never bind a port to `0.0.0.0`.** Both published ports bind the Tailscale
  address on purpose.
- **Never print a secret.** Credentials live as files in `secrets/` (0700 dir) and
  are referred to by path.
- Adding an entry to `SERVICE_CATALOGUE` in `scripts/collector.py` is a
  **security change** — it is the complete allowlist of endpoints the collector
  will ever contact.
- Collector probes must not follow redirects. One did, once, and left the
  allowlist.
- **Read other services through their own API, not their database**, where one
  exists. The Carbo Design adapter uses a token scoped to that project's six
  `*:read` permissions, so Carbo Design refuses a write itself rather than this
  gateway merely choosing not to attempt one.
- **A monitoring tool must fail loudly when unconfigured.** The Uptime Kuma
  tools raise `unavailable` with setup steps rather than reporting zero
  monitors, because "nothing is down" is the worst possible wrong answer.
- Run `make test` and `make validate` before any deploy. Tag
  `carbo-mcp-gateway:previous` first so `make rollback` works.

---

## LAYOUT

```
/opt/carbo-mcp
├── docker-compose.yml       3 services, digest-pinned, tailnet-bound
├── Dockerfile               multi-stage → distroless runtime
├── Dockerfile.keycloak      Keycloak pre-built for Postgres
├── Makefile                 operations, scoped to this stack
├── .env                     compose settings (no secrets)
├── config/gateway.env       gateway runtime settings (no secrets)
├── secrets/                 0700; credentials as files, never in compose or git
├── data/snapshots/          collector output, mounted read-only
├── data/audit/              audit log, the only writable mount
├── scripts/                 collector, Keycloak setup, health check, rollback
├── src/                     TypeScript gateway
├── tests/                   151 tests
└── docs/                    11 documents (see README.md)
```

---

## WHERE TO READ MORE

| Question | Document |
|---|---|
| Why is it built this way? | `docs/ARCHITECTURE.md` |
| What does each tool do and not do? | `docs/TOOLS.md` |
| What is the threat model? | `docs/SECURITY.md` |
| How does auth work? Adding/revoking users? | `docs/AUTHENTICATION.md` |
| Reverse proxy config | `docs/NGINX_PROXY_MANAGER.md` |
| Connecting Claude.ai, test prompts, revoking | `docs/CLAUDE_AI_CONNECTION.md` |
| Day-to-day running, backups, upgrades | `docs/OPERATIONS.md` |
| Something is broken | `docs/TROUBLESHOOTING.md` |
| Undo a deployment, or remove it entirely | `docs/ROLLBACK.md` |
| What changed and why | `docs/CHANGELOG.md` |
| What is on this server and how it was classified | `docs/SERVICE_INVENTORY.md` |

---

## CURRENT STATUS

Live since 2026-09-05. Connected to Claude.ai and serving. 189 tests passing.
All 29 pre-existing containers untouched.

Kling AI tools **enabled and deployed 2026-09-11** (24 tools, `COMPOSE_FILE`
override in `.env`, `secrets/kling_api_key` in place, `carbo:kling:generate`
scope in Keycloak). Storage is the LinkStation NAS share: images in
`\\10.0.0.129\Carbo_Folder\Videos\Kling\input`, results in `Videos\Kling`
(needs the NAS at 10.0.0.129 reachable). **Not yet live-tested: no paid job has been submitted.**
Key rotation: `sudo bash scripts/set-kling-key.sh`, then `make restart-gateway`.

**Next action:** reconnect the Claude.ai connector so it consents to the new
scope, then one approved 5-second live test after a `dry_run`. Optional follow-ups are listed in
`docs/OPERATIONS.md` under the monthly checklist.
