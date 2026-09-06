# Operations

Every command below is scoped to this stack. None of them can affect the 29
unrelated containers on carbo-server: compose is always invoked with this
project's file and name, and nothing here runs a bare `docker restart`,
`docker system prune`, or an unscoped `docker compose down`.

## Daily commands

```bash
cd /opt/carbo-mcp

make help              # every target
make status            # container status + collector timer
make health            # containers, internal, public, auth boundary, collector
make audit             # recent audit events
make logs              # follow gateway logs (sanitized)
make logs-keycloak     # follow Keycloak logs
make collect           # refresh host snapshots now
```

## Lifecycle

```bash
make start             # start this stack
make stop              # stop this stack only
make restart           # restart this stack only
make restart-gateway   # restart just the gateway; Keycloak keeps its sessions
make deploy            # validate → test → build → roll out → health check
```

`make stop` leaves every other container on the host running. It stops exactly
`carbo-mcp`, `carbo-keycloak`, and `carbo-keycloak-db`.

## Checks

```bash
make validate   # compose syntax, required files, secret permissions,
                # no literal credentials in tracked files, port binding
make test       # typecheck + 112 tests
make scan       # npm audit (production deps) + trivy if installed
```

`make validate` fails if a secret file becomes world-readable or if anything
credential-shaped appears in a tracked file. Run it before every deploy —
`make deploy` does.

## Backups

```bash
make backup
```

Writes three files into `backups/`:

| File | Contents |
|---|---|
| `keycloak-db-<stamp>.sql.gz` | Full Keycloak database — realm, clients, scopes, users |
| `carbo-mcp-config-<stamp>.tar.gz` | Compose, Dockerfiles, config, scripts, source, tests, docs |
| `carbo-mcp-secrets-<stamp>.tar.gz` | The `secrets/` directory, **mode 0600** |

Keep the secrets archive at 0600 and out of any general backup that leaves this
host, or treat that destination as equally sensitive.

Snapshots are deliberately not backed up — they regenerate every two minutes.

Suggested cadence: before any change to the stack, and monthly otherwise. The
existing `/opt/backup-to-ec2.sh` does not currently include `/opt/carbo-mcp`; add
it there if you want this in the offsite rotation.

## The collector

The privileged half of the design. Runs on the host, not in a container.

```bash
systemctl status carbo-mcp-collector.timer
systemctl list-timers carbo-mcp-collector.timer
sudo journalctl -u carbo-mcp-collector.service -n 50
sudo systemctl start carbo-mcp-collector.service    # run once now
```

Every two minutes, comfortably inside the gateway's 300-second freshness window.
If it stops, `/ready` starts returning 503 and every tool reports
`fresh: false` with the real age — it degrades honestly rather than serving
stale data as current.

### Adding a service to the catalogue

Edit `SERVICE_CATALOGUE` in `scripts/collector.py` — id, display name, category,
description, container name (or `None`), probe URL (or `None`). Then:

```bash
make collect
```

This list is an allowlist: it is the complete set of endpoints the collector will
ever contact. Vaultwarden, wetty, and every database port are absent on purpose.
Adding one is a deliberate act, so treat an edit here as a security change.

## Upgrades

### Gateway dependencies

```bash
cd /opt/carbo-mcp
docker tag carbo-mcp-gateway:1.0.0 carbo-mcp-gateway:previous   # rollback point
# edit exact versions in package.json
npm install --legacy-peer-deps
make test
make deploy
```

Versions are pinned exactly on purpose. `make rollback` needs the `:previous`
tag, so always create it before deploying.

> `npm install` needs `--legacy-peer-deps` here: npm 10 fails with
> `Cannot read properties of null (reading 'edgesOut')` resolving the MCP SDK's
> optional peer dependencies.

### Keycloak

1. Check the [Keycloak upgrade notes](https://www.keycloak.org/docs/latest/upgrading/).
2. `make backup`.
3. Update the digest and comment in `Dockerfile.keycloak` (both `FROM` lines).
4. `make build && make start`.
5. `make health`, then sign in once through Claude.ai to confirm the flow.

### Node base images

Update both digests in `Dockerfile` (builder and runtime), keeping the
human-readable tag comment beside each accurate. Then `make test && make deploy`.

## Certificate renewal

Certbot on the VPS renews automatically, twice daily, using the schedule that
already existed. To check:

```bash
ssh root@100.94.212.114 'certbot certificates | grep -A2 mcp.carbocomputers.com'
```

Nothing here needs to change on renewal — nginx reads the live symlink.

## Log locations

| Log | Where |
|---|---|
| Gateway application | `docker logs carbo-mcp` (json-file, 10 MB × 5) |
| Gateway audit trail | `/opt/carbo-mcp/data/audit/audit.log` (16 MB × 14, rotated in-process) |
| Keycloak | `docker logs carbo-keycloak` |
| Collector | `journalctl -u carbo-mcp-collector.service` |
| nginx (VPS) | `/var/log/nginx/carbo-mcp.{access,error}.log` |

### Audit retention

14 rotated files at 16 MB each, roughly 224 MB worst case. At the observed rate
that is well over a year. To change, edit `MCP_AUDIT_MAX_FILES` /
`MCP_AUDIT_MAX_FILE_BYTES` in `config/gateway.env` and `make restart-gateway`.

Audit records contain no tokens, no argument values, and no tool responses —
only subject, client, tool or JSON-RPC method, scope, parameter *shapes*,
outcome, HTTP status, duration, and error category.

Recorded events:

| Event | When |
|---|---|
| `initialize` | A client connects. Carries the client's name and version |
| `tools_list` | A client enumerates tools |
| `tool_call` | A tool runs. Carries the required scope and parameter shapes |
| `protocol` | Any other JSON-RPC message that **failed**; successes are not recorded, to keep notifications and keepalives out of the log |
| `auth_failure` | A token was missing, malformed, expired, wrong-audience, wrong-issuer, or carried no gateway scope |
| `rate_limit` | A caller exceeded their budget |
| `startup` / `shutdown` | Process lifecycle |

A normal Claude.ai connection looks like this:

```
tools_list    tools/list v=2026-06-18   error     400   ← version probe, expected
initialize    initialize (Claude)       success   200
tools_list    tools/list                success   200
tool_call     carbo_get_server_health   success     -
```

The first line is Claude offering a protocol version newer than the installed
SDK supports; it negotiates down immediately. It is normal, and it will stop
appearing when the MCP SDK gains support for that version.

## Uptime Kuma API key

The monitoring tools need a read-only API key from Uptime Kuma. Without one they
report "not configured" with these instructions rather than failing opaquely.

1. Open `http://100.69.59.37` over Tailscale and sign in.
2. **Profile -> Settings -> API Keys -> Add API Key**.
3. Name it `carbo-mcp-gateway`, set an expiry if you want one, **Save**.
4. Copy the key, then on carbo-server:

```bash
umask 077
printf '%s' 'PASTE_THE_KEY_HERE' > /opt/carbo-mcp/secrets/uptime_kuma_api_key
chmod 600 /opt/carbo-mcp/secrets/uptime_kuma_api_key
make collect
```

No restart is needed -- the collector reads the file on its next run. Verify:

```bash
sudo python3 -c "import json;d=json.load(open('/opt/carbo-mcp/data/snapshots/monitoring.json'))['data'];print(d['configured'], d['counts'])"
```

To revoke, delete the key in Uptime Kuma and remove the file.

## Carbo Design API token

The design tools authenticate to Carbo Design with a token holding only its six
`*:read` scopes, stored at `secrets/carbo_design_api_token`. It was created
through Carbo Design's own `/api/auth/tokens` endpoint and appears there as
`carbo-mcp-gateway (read-only)`. Writes are refused by Carbo Design itself -- a
`POST /api/projects` with this token returns 403, verified at deployment.

To revoke it, delete the token in Carbo Design and remove the file. The design
tools then report the service as unavailable.

## Tuning

All in `config/gateway.env`; apply with `make restart-gateway`.

| Setting | Default | Raise if | Lower if |
|---|---|---|---|
| `MCP_RATE_LIMIT_MAX` | 120/min | Claude hits 429 in normal use | You want a tighter budget |
| `MCP_TOOL_TIMEOUT_MS` | 10000 | A tool legitimately needs longer | You want faster failure |
| `MCP_SNAPSHOT_MAX_AGE_SECONDS` | 300 | The collector interval is lengthened | You want staleness caught sooner |
| `MCP_LOG_LEVEL` | info | Debugging (`debug`) | Quieter (`warn`) |
| `MCP_ALLOWED_SUBJECTS` | empty | — | You want to pin access to specific users |

## Monthly checklist

- [ ] `make health` — all checks pass
- [ ] `make audit` — no unexpected subjects or repeated `auth_failure`
- [ ] `make scan` — review HIGH/CRITICAL findings
- [ ] `make backup`
- [ ] Confirm the certificate renewed (expiry more than 30 days out)
- [ ] Check for a Keycloak patch release
