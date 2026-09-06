# Carbo MCP Gateway — Service Inventory (Phase 1 Discovery)

**Discovery date:** 2026-09-05
**Host:** carbo-server (Debian 13 trixie, x86_64, Linux 6.12.107)
**Docker Engine:** 29.7.2 | **Docker Compose:** v5.4.0
**Resources:** 31 GiB RAM (17 GiB available), 883 GB disk (43% used, 479 GB free)
**Discovery method:** read-only inspection only. No container, config, or service was modified.

---

## 1. Critical infrastructure findings

These three findings change the deployment design from what was assumed in the brief.

| # | Assumption in brief | Actual state on the server | Consequence |
|---|---|---|---|
| 1 | Nginx Proxy Manager is the reverse proxy | **No Nginx Proxy Manager exists on any host.** The public reverse proxy is stock **nginx 1.24.0 + Certbot** on the Linode VPS `srv1312203` (76.13.113.165, Ubuntu 24.04) | TLS termination and vhost config are done in nginx config files, not the NPM UI. NPM-equivalent settings are still documented in `NGINX_PROXY_MANAGER.md`. |
| 2 | `mcp.carbocomputers.com` resolves to this server | It resolves to **76.13.113.165** — the **Linode VPS**, not carbo-server. carbo-server's public IP is 47.201.160.3 (residential) and UFW denies inbound 80/443 | The MCP gateway runs on carbo-server but is reached **through the VPS over Tailscale**. This is the established pattern already used by `term.carbocomputers.com` and `carbo-server.carbocomputers.com`. |
| 3 | An identity provider is available | **No OAuth 2.1 authorization server is installed** on any host (no Keycloak, Authentik, Hydra, Authelia, cloudflared) | An authorization server must be selected before authenticated access can be completed. See `AUTHENTICATION.md`. |

### Confirmed public traffic path

```
Claude.ai
  → HTTPS 443 → nginx + Let's Encrypt on Linode VPS (76.13.113.165)
  → Tailscale (100.94.212.114 → 100.71.174.8)
  → carbo-server: carbo-mcp container bound to 100.71.174.8:8110 (tailnet-only)
  → read-only internal service adapters
```

Verified: the VPS reaches carbo-server over Tailscale (`curl http://100.71.174.8:5678/` → HTTP 200).
Verified: TCP 8110 is free on carbo-server.

---

## 2. Host inventory

| Host | Role | Address | Tailscale | Notes |
|---|---|---|---|---|
| carbo-server | Primary Docker host — **MCP gateway target** | 10.0.0.39 | 100.71.174.8 | Debian 13, 29 containers, UFW active |
| srv1312203 (Linode VPS) | Public edge — nginx + Certbot, AzuraCast | 76.13.113.165 | 100.94.212.114 | **Holds the `mcp.carbocomputers.com` A record** |
| Linode WP server | 5 WordPress sites | 172.235.150.181 | — | nginx + 10 containers |
| raspberrypi | Pi-hole DNS | 10.0.0.50 | 100.109.240.107 | Nextcloud not currently running |
| AWS EC2 | uptime-kuma (tailnet-only) | — | 100.69.59.37 | Reached by Tailscale only |
| Humble House Radio | AzuraCast | 172.233.177.118 | 100.110.193.81 | — |

---

## 3. carbo-server container inventory (29 containers, all running unless noted)

| Service | Container | Purpose | Internal address | Port | API | Auth | Read | Write | Risk | MCP recommendation |
|---|---|---|---|---|---|---|---|---|---|---|
| n8n | `n8n` | Workflow automation | 127.0.0.1 | 5678 | REST `/api/v1` + `/healthz` | API key (**not configured**) | Workflows, executions | Full | High | **Level 1** — health via `/healthz` (open); workflow/execution listing via **read-only SQLite** on `n8n_n8n_data`, sanitized |
| Carbo Design API | `carbo-design-api` | Design service backend | 127.0.0.1 | 8101 | `/healthz` (200) | unknown | Health | Unknown | Medium | **Level 1** — health probe only |
| Carbo Design Studio | `carbo-design-studio` | Design UI | 127.0.0.1 | 8102 | — | — | — | — | Medium | Level 1 — container status only |
| Carbo Design MCP | `carbo-design-mcp` | Existing local MCP server | 127.0.0.1 | 8104 | MCP | unknown | — | — | Medium | Not wrapped — separate service, left untouched |
| Carbo Design DB | `carbo-design-db` | postgres:17-alpine | internal | 5432 | SQL | password | — | — | High | **Excluded** — no SQL exposure |
| Staging WP | `cd-staging-wp` / `cd-staging-db` | Carbo Design staging | 127.0.0.1 | 8109 | HTTP | — | HTTP status | — | Medium | Level 1 — HTTP status probe |
| WordPress (local) | `wordpress` / `wordpress_db` | Local WP | 127.0.0.1 | 8080 | HTTP | — | HTTP status | — | Medium | Level 1 — HTTP status probe |
| HBB admin dashboard | `hbb-admin-dashboard` / `hbb-db` | Holiday Bail Bonds | 127.0.0.1 | 8085 | HTTP | — | HTTP status | — | Medium | Level 1 — HTTP status probe |
| DJ Music Selector | `dj-music-selector` | DJ tooling | 127.0.0.1 | 3000 | HTTP | — | HTTP status | — | Low | Level 1 — HTTP status probe |
| Vaultwarden | `vaultwarden` | **Password manager** | 127.0.0.1 | 8097 | HTTP | own auth | — | — | **Critical** | **Excluded entirely** — container status only, no probes, no data |
| wetty | `wetty` | **Web terminal** | 127.0.0.1 | 3001 | HTTP | own auth | — | shell | **Critical** | **Excluded entirely** — not exposed by any tool |
| Nextcloud | `nextcloud` / `nextcloud_db` | File sync | 0.0.0.0 | 8087 | HTTP | own auth | HTTP status | — | High | Level 1 — HTTP status probe only |
| FreshRSS ×2 | `freshrss`, `gaming-freshrss` | RSS readers | 0.0.0.0 | 8090 / 8093 | HTTP | own auth | HTTP status | — | Low | Level 1 — HTTP status probe |
| News/gaming tickers | `news-ticker`, `gaming-ticker` | Ticker feeds | 0.0.0.0 | 8092 / 8094 | HTTP | — | HTTP status | — | Low | Level 1 — HTTP status probe |
| SillyTavern | `sillytavern` | AI chat frontend | 0.0.0.0 | 8096 | HTTP | own auth | HTTP status | — | Medium | Level 1 — HTTP status probe |
| Muse proxy | `muse-proxy` | Proxy service | 0.0.0.0 | 8095 | HTTP | — | HTTP status | — | Low | Level 1 — HTTP status probe |
| RP assistant | `carbo-rp-assistant` | nginx static | 0.0.0.0 | 8098 | HTTP | — | HTTP status | — | Low | Level 1 — HTTP status probe |
| Server monitor | `carbo-server-monitor` | Monitoring UI | 0.0.0.0 | 30000 | HTTP | — | HTTP status | — | Low | Level 1 — HTTP status probe |
| CapCut Mate | `capcut-mate`, `capcut-mate-web` | Video utility | internal | 30000/80 | — | — | — | — | Low | Level 1 — container status only |
| Daily reports | `carbo-daily-reports` | Report generator | — | — | — | — | Report artifacts | — | Low | Level 1 — last-run summary |
| Comprehensive report | `comprehensive-report` | Report generator | — | — | — | — | Report artifacts | — | Low | Level 1 — last-run summary |
| Discord bot | `fla-gaming-discord-bot` | Gaming news bot | — | — | — | — | Container health | Posts to Discord | Medium | Level 1 — container status only (posting is Level 3) |
| Ollama (host) | — | Local LLM | 127.0.0.1 | 11434 | HTTP | — | HTTP status | — | Low | Level 1 — HTTP status probe |
| — | `gracious_panini`, `competent_shaw` | `hello-world`, exited 7 months ago | — | — | — | — | — | — | None | Ignored (dormant) |

---

## 4. Non-container assets on carbo-server

| Asset | Location | Purpose | MCP recommendation |
|---|---|---|---|
| Video Factory v2 | `/home/sircarbo/factory_v2` (git repo) | Video generation pipeline; Huey + SQLite job queue, JSON sidecar job state, `logs/vf2.log`; runs nightly via `vf2-overnight.timer` (02:00) | **Level 1** — job status from JSON sidecars + last run from timer state; sanitized log tail |
| Security monitor | `/opt/security-monitor` | Nightly scan 01:00, logs in `logs/scan-*.log` | **Level 1** — last scan timestamp + result summary (sanitized) |
| Carbo Design backups | `/opt/carbo-design/storage/backups` | Nightly 02:30 DB dumps, 30-day retention | **Level 1** — latest backup age/size/count, never contents |
| Offsite backup | `/opt/backup-to-ec2.sh` | Nightly backup to EC2 | Level 1 — last-run status only |
| Daily reports | `/opt/carbo-daily-reports/data` | Generated daily reports | Level 1 — last report timestamp |
| Git repos | `/opt/carbo-design`, `/home/sircarbo/factory_v2`, `/home/sircarbo/repos/carbocomp-site`, `/home/sircarbo/repos/djcarbo-site`, `/home/sircarbo/docker/capcut-mate` | Project source | **Level 1** — branch, dirty flag, last commit subject/date. No diffs, no file contents |
| carbo_post | `/home/sircarbo/carbo_post` | Facebook posting webhooks (ports 8765/8766/8091) | **Excluded** — publishing surface (Level 3) |
| Samba shares | `/mnt/music-folder`, `/mnt/my-passport`, `/mnt/carbo-folder` | File shares | **Excluded** — no filesystem browsing tools |
| KVM VM | CARBO-VM-01 (Windows 11) | Windows VM | Level 1 — libvirt domain state only (deferred, not enabled) |

---

## 5. Scheduled jobs discovered

| Job | Schedule | Source |
|---|---|---|
| Comprehensive daily report | 07:00 daily | root crontab |
| Report email | 07:05 daily | root crontab |
| Security scan | 01:00 daily | root crontab |
| Carbo Design backup | 02:30 daily | `/etc/cron.d/carbo-design-backup` |
| VF2 overnight batch | 02:00 daily | `vf2-overnight.timer` |
| Tailscale cert renew | weekly Mon 00:00 | `renew-carbo-tailscale-cert.timer` |
| carbo_post retry | 08:00–11:00 hourly | sircarbo crontab |
| Performance loop | Mon 06:00 | sircarbo crontab |

---

## 6. Security posture at discovery

| Item | State |
|---|---|
| UFW | **Active.** Inbound allowed: 22/tcp, 5901–5902/tcp (VNC), 7681/tcp (ttyd); full access from 10.0.0.0/24 and `tailscale0`; 25/tcp from VPS only |
| Public 80/443 to carbo-server | **Blocked** by UFW — carbo-server is not directly reachable from the internet on HTTP(S) |
| Apache (host) | Active on 80/443/8081–8086 — LAN/tailnet only, 12 vhosts |
| Docker socket | Not mounted into any planned MCP container |
| Existing MCP servers | `carbo-design-mcp` on 127.0.0.1:8104 (untouched). A Claude.ai connector named "Carbo Server" is configured in the account and currently returns 502 — unrelated to this build; it points at an endpoint that is not serving |

---

## 7. Excluded from MCP exposure (hard exclusions)

These are never wrapped by a tool at any level, regardless of future phases:

- Vaultwarden data or API (password manager)
- wetty / ttyd / SSH / any shell surface
- Any SQL console or raw database access (postgres, mariadb, sqlite writes)
- Docker control socket
- Environment variable values, `.env` files, tokens, keys, certificates
- Samba share contents and general filesystem browsing
- Full log files (only bounded, sanitized summaries)
- carbo_post publishing endpoints
