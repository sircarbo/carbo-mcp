# Security

## Threat model

The gateway is reachable from the public internet by anyone who finds the
hostname. The assumptions are: an attacker can send arbitrary requests to
`https://mcp.carbocomputers.com`, can attempt to forge or replay tokens, and may
eventually find a bug in Node, Express, or the MCP SDK.

The design therefore assumes the gateway process **will** be compromised at some
point, and limits what that is worth.

## What a full compromise of the gateway yields

| The attacker gets | Because |
|---|---|
| Nine JSON snapshot files | Mounted read-only; already sanitized by the collector |
| The audit log | The only writable mount; contains no tokens, headers, or argument values — only subjects, methods, tool names, outcomes and timings |
| Nothing else | See below |

| The attacker does **not** get | Because |
|---|---|
| A shell | The distroless base has no `/bin/sh`, no busybox, no coreutils |
| Tools to install | No package manager in the runtime image |
| The Docker socket | Never mounted, in this or any container in the stack |
| Host filesystem access | Only two bind mounts exist: snapshots (ro) and audit (rw) |
| Database credentials | The gateway has none — it never talks to a database |
| Write access to anything but the audit log | `read_only: true` root filesystem; `/tmp` is `noexec,nosuid,nodev` tmpfs |
| Privilege escalation | `no-new-privileges`, all capabilities dropped, uid 65532 |
| Reach to Vaultwarden, wetty, or any database | The container never probes application ports; the collector does, from an allowlist |

## Container hardening

| Control | Gateway | Keycloak | Postgres |
|---|---|---|---|
| Runs as non-root | uid/gid 65532 | uid/gid 1000 | postgres (drops from root) |
| Read-only root filesystem | **yes** | no (needs its data dir) | no |
| `no-new-privileges` | yes | yes | yes |
| Capabilities | **all dropped** | all dropped | all dropped, then 5 re-added for privilege drop at startup |
| Privileged | no | no | no |
| Host networking | no | no | no |
| Docker socket | no | no | no |
| Base image | distroless (no shell, no package manager) | Keycloak UBI, pre-built | postgres:17.7-alpine |
| Image pinned by digest | yes | yes (base) | yes |
| CPU / memory limits | 1.0 / 384M | 2.0 / 1024M | 1.0 / 512M |
| Health check | yes | yes | yes |
| `restart: unless-stopped` | yes | yes | yes |
| Published port | 100.71.174.8:8110 | 100.71.174.8:8111 | **none** |
| Log rotation | 10m × 5 | 10m × 5 | 10m × 3 |

Neither published port binds `0.0.0.0`. Both bind the Tailscale address, so the
only reachable path is from the tailnet — which is how the VPS reverse proxy
gets in, and how nothing else does.

## Network isolation

`carbo-mcp-internal` is declared `internal: true`, so it has no gateway to the
host or the internet. Postgres is only ever on that network and has no published
port: there is no route to it from outside the stack, with or without a password.

The gateway is on both networks — `edge` is required for port publishing to work
at all. It uses `internal` to fetch Keycloak's JWKS, so public-key fetches never
leave the host.

## Secrets

Credentials exist only as files under `/opt/carbo-mcp/secrets/` (directory mode
0700). They are not in `docker-compose.yml`, the Dockerfile, either image, this
documentation, or git (`secrets/` is in `.gitignore`).

| File | Purpose |
|---|---|
| `keycloak_db_password` | Postgres password |
| `keycloak_admin_password` | Keycloak `carbo-admin` account |
| `keycloak_user_password` | The `carbo` login account |
| `claude_connector_client_secret` | OAuth client secret for the static connector client |

The first two are mode 0640, group `sircarbo` (gid 1000). This is deliberate:
Compose in non-swarm mode bind-mounts secret files verbatim, so the container's
uid must be able to read them — during deployment they were initially mode 0600
and Keycloak silently started with **no database password at all**. The 0700
directory still blocks every other host user from reaching the files.

Keycloak 26 has no generic `KC_<OPTION>_FILE` support; `KC_DB_PASSWORD_FILE` is
silently ignored. `scripts/keycloak-entrypoint.sh` reads the mounted files into
the environment and execs `kc.sh`, which is what keeps the values out of
`docker-compose.yml` and `docker inspect`.

`make validate` fails the build if any secret file becomes world-readable or if
a literal-looking credential appears in a tracked file.

## Redaction

Two independent layers, because one is not enough:

1. **The collector** sanitizes before writing a snapshot — JWTs, bearer and
   basic headers, private keys, provider token formats, URL-embedded
   credentials, email addresses, IP addresses, absolute paths, any
   `NAME=value` where the name ends in a credential word, any
   `SHOUTY_ENV_VAR=value` regardless of name, and any opaque 40+ character blob.
2. **The gateway** redacts again on every log line, audit record, and tool
   response, using the same rule set plus key-name matching.

The `SHOUTY_ENV_VAR` rule exists because of a real case found here: a
capcut-mate commit subject contains `TOS_ACCESS_KEY_ID=…`, whose name ends in
"ID" and so matched none of the keyword-suffix patterns.

25 redaction tests cover these paths, including cycle-breaking, depth and
breadth bounds, and stack-trace suppression on errors.

## Authentication and authorization

Detailed in [AUTHENTICATION.md](AUTHENTICATION.md). Summary of what is enforced
on every `/mcp` request:

- HTTPS only; HTTP 301-redirects and HSTS is set for a year.
- Bearer token required. No anonymous access, no API key, no credential in a URL.
- JWT signature verified against Keycloak's JWKS (RS256/384/512, ES256/384, PS256
  only — `none` and HMAC are not in the accepted list).
- `iss` must equal `https://mcp.carbocomputers.com/realms/carbo`.
- `aud` must contain `https://mcp.carbocomputers.com/mcp`. A token minted for any
  other resource is refused, which is what stops a token from another service in
  the same realm being replayed here.
- `exp` and `nbf` checked with 30 seconds of clock tolerance.
- Scopes are intersected with the eight the gateway defines, so an unrelated
  scope cannot smuggle in authority.
- Optional `MCP_ALLOWED_SUBJECTS` allowlist as a second gate.
- Zero-scope tokens are refused with 403 `insufficient_scope`.
- Per-tool scope check runs again inside the handler wrapper.

Rejections carry a stable category and never echo token contents, internal
paths, or exception text.

## Rate limiting and request limits

| Control | Value |
|---|---|
| Unauthenticated requests | 20 per minute per source (IPv6 keyed on /64) |
| Authenticated requests | 120 per minute per subject |
| nginx edge limit | 10 r/s burst 20 on `/mcp`; 5 r/s burst 20 on `/realms/` |
| Request body | 256 KB (nginx caps at 1 MB first) |
| Request timeout | 30 s |
| Tool timeout | 10 s |
| Keycloak brute force | 5 failures, 900 s lockout |
| Access token lifetime | 900 s |

IPv6 keys are masked to a /64 by the library's `ipKeyGenerator`. Keying on the
raw address would let anyone with an ordinary IPv6 allocation rotate addresses
to evade the limit.

## Hard exclusions

Never exposed through any tool, at any level, under any configuration:

- Vaultwarden (password manager) — data, API, and HTTP probing
- wetty / ttyd / SSH / any shell or terminal surface (wetty's liveness is reported by the collector since 2026-09-11; the terminal itself is never proxied or reachable)
- Any SQL console or raw database access
- The Docker control socket
- Environment variable values, `.env` files, tokens, keys, certificates
- Samba share contents and general filesystem browsing
- Full log files (only bounded, deduplicated, sanitized patterns)
- The `carbo_post` publishing endpoints
- Arbitrary command execution

## Vulnerability scanning

```bash
make scan          # npm audit on production deps, plus trivy if installed
```

Trivy is not installed on this host. To scan without installing anything
permanently:

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  aquasec/trivy:latest image --severity HIGH,CRITICAL --ignore-unfixed \
  carbo-mcp-gateway:1.0.0
```

That scanner container needs the Docker socket; the gateway never does.

Recommended cadence: `npm audit` monthly, image scan before each rebuild, and a
Keycloak minor-version check quarterly (see [OPERATIONS.md](OPERATIONS.md)).

## Known residual risks

| Risk | Assessment |
|---|---|
| The gateway container has outbound network access via the `edge` bridge | Unavoidable: Docker port publishing requires a bridge with a gateway. Mitigated by the container holding no credentials, no shell, and no package manager. A `DOCKER-USER` iptables rule could block egress; not applied, as changing the firewall for a marginal gain was judged the larger risk |
| Snapshots are up to 2 minutes old | Stated explicitly in every response's `freshness` block; `/ready` fails when stale |
| All realm users receive all eight read scopes | Single-operator deployment. Narrowing is documented in [AUTHENTICATION.md](AUTHENTICATION.md#narrowing-scopes-per-user); `MCP_ALLOWED_SUBJECTS` is available now as a per-subject gate |
| Keycloak's admin console is reachable over the tailnet | Not published publicly (nginx returns 404 for `/admin/`). Tailnet access is already the trust boundary for this server |
| The collector runs as root | Deliberate, and the reason the exposed half does not have to. Constrained by a hardened systemd unit |
