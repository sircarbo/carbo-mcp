# Architecture

## The problem this shape solves

Two constraints pull in opposite directions.

The gateway needs to answer questions about the host: which containers are
unhealthy, how full is the disk, did last night's n8n run succeed, is the
backup current. Answering those needs the Docker socket, the host filesystem,
and a read of n8n's database.

The gateway is also the one process on this server reachable from the public
internet. Giving *that* process the Docker socket and host filesystem access
would mean a single remote-code-execution bug hands an attacker the whole box.

The design resolves this by splitting the two roles apart.

## The collector split

```
                        the privileged half                 the exposed half
                        ───────────────────                 ────────────────
  Docker socket ──┐
  /proc, /sys  ───┤                                  ┌──────────────────────┐
  n8n SQLite   ───┼──▶  carbo-mcp-collector.timer    │   carbo-mcp          │
  git repos    ───┤     (systemd, root, every 2m)    │   distroless         │
  log files    ───┤              │                   │   uid 65532          │
  HTTP probes  ───┘              │ writes            │   read-only rootfs   │
                                 ▼                   │   all caps dropped   │
                     /opt/carbo-mcp/data/snapshots ──┼─▶ mounted :ro         │
                     sanitized JSON, 9 files         │                      │
                                                     └──────────────────────┘
                                                                │
                                                          public HTTPS
```

The collector runs on the host as root, under a hardened systemd unit
(`ProtectSystem=strict`, a single `ReadWritePaths`, `SystemCallFilter`,
`MemoryDenyWriteExecute`, `CapabilityBoundingSet=CAP_DAC_READ_SEARCH`). It
gathers, sanitizes, and writes nine JSON snapshots. It never serves a request
and has no network listener.

The gateway container reads those snapshots read-only and serves MCP. It has no
Docker socket, no host filesystem, no database credentials, and no reason to
talk to any application port.

**What this buys:** full compromise of the internet-facing process yields
exactly the data the collector already decided was safe to publish. There is no
socket to pivot through, no shell to spawn (the distroless base has none), no
package manager to install tools with, and no writable filesystem outside a
single audit directory.

**What it costs:** data is up to two minutes old rather than live. Every tool
response carries a `freshness` block stating its age, and the model is
instructed to say "as of N seconds ago" rather than implying a live reading.
`/ready` returns 503 when a required snapshot goes stale.

## Why the collector also does the HTTP probing

Probing service health from inside the container would require
`host.docker.internal`, which would give the container a route to *every* host
port — including Vaultwarden's and wetty's. Moving probing into the collector
means the container needs no egress to application ports at all, and the set of
endpoints that get contacted is a literal allowlist in one file
(`SERVICE_CATALOGUE` and `WEBSITE_CATALOGUE` in `scripts/collector.py`).

The probe deliberately does not follow redirects. During development, Nextcloud
answered `/` with a 302 to `https://nextcloud.carbo.lan/login`, and a
redirect-following probe silently contacted a host nobody had approved. A 3xx
already proves the service is answering, so refusing to follow keeps every
outbound request as auditable as the catalogue claims.

## Public traffic path

```
Claude.ai
   │ HTTPS 443, Let's Encrypt, HSTS, HTTP/2
   ▼
nginx 1.24 on Linode VPS  (76.13.113.165 / tailscale 100.94.212.114)
   │  routes by path:
   │    /mcp, /health, /ready, /.well-known/oauth-protected-resource*  → gateway
   │    /realms/, /resources/, /js/, /.well-known/oauth-auth*-server*  → Keycloak
   │    /admin/, /metrics/, everything else                            → 404
   │ Tailscale
   ▼
carbo-server 100.71.174.8
   ├─ :8110  carbo-mcp        edge + internal networks
   ├─ :8111  carbo-keycloak   edge + internal networks
   └─ (none) carbo-keycloak-db  internal network only
```

carbo-server's own public address is residential and UFW denies inbound 80/443,
so the VPS is the only entrance. This reuses the pattern already in production
for `term.carbocomputers.com` and `carbo-server.carbocomputers.com`.

### Why both services live on one hostname

Only one DNS record existed: `mcp.carbocomputers.com`. Rather than ask for a
second record for the authorization server, Keycloak is served from the same
hostname at `/realms/…`, which makes the issuer
`https://mcp.carbocomputers.com/realms/carbo`. RFC 8414 places that issuer's
metadata at `/.well-known/oauth-authorization-server/realms/carbo`, which
Keycloak serves natively — verified working. Keycloak's admin console is *not*
published; it is reachable only over Tailscale at `http://100.71.174.8:8111/admin/`.

## Networks

| Network | Type | Members | Purpose |
|---|---|---|---|
| `carbo-mcp-edge` | bridge | gateway, Keycloak | carries the two published (tailnet-bound) ports |
| `carbo-mcp-internal` | bridge, `internal: true` | gateway, Keycloak, Postgres | no gateway to the host or internet; the database is only ever here |

The gateway reaches Keycloak's JWKS over `carbo-mcp-internal`, so public key
fetches never leave the host.

Both networks are new and named. No existing stack's network was joined or
modified.

## Language and SDK

**TypeScript on Node 22**, using `@modelcontextprotocol/sdk` 1.30.0.

- The official TypeScript SDK has the most complete Streamable HTTP transport,
  including the stateless mode this deployment uses.
- Node was already the runtime for other services here, and a distroless Node
  base image exists and is maintained, which the hardening requirements needed.
- Static types let every tool's input and output schema be declared once and
  reused for validation, for the MCP schema, and for the tests.

All production dependencies are pinned to exact versions; both base images are
pinned by digest.

## Stateless transport

Each POST to `/mcp` constructs a fresh `McpServer` and transport, handles the
request, and tears both down. Nothing is retained between requests.

This costs a little construction work per call and buys the property that
matters for a multi-user gateway: no session state can survive a request or
leak between two callers. It also means a container restart drops no session —
Claude simply sends its next request.

Tools are registered per-request against the caller's scopes, so `tools/list` is
already scope-filtered and the model is never shown a capability it would be
refused. A caller whose token carries none of the gateway's scopes is refused
with 403 `insufficient_scope` rather than handed an empty list.

## Request pipeline

```
correlation id  →  timeout guard  →  security headers
   →  unauthenticated rate limit (per source /64)
   →  JSON body parse, 256 KB cap
   →  bearer authentication  (signature, iss, aud, exp, nbf, scopes, subject allowlist)
   →  authenticated rate limit (per subject)
   →  MCP transport
        →  per-tool scope check (again — a registration bug must not become an authorization bug)
        →  zod input validation
        →  handler with AbortController timeout
        →  audit record for every outcome
```

## Component map

| Path | Role |
|---|---|
| `src/config.ts` | Strict startup validation; the process aborts rather than half-working |
| `src/auth/tokenVerifier.ts` | JWKS fetch, signature, issuer, audience, expiry, scope extraction |
| `src/auth/metadata.ts` | RFC 9728 protected resource metadata and the `WWW-Authenticate` challenge |
| `src/middleware/` | Correlation id, authentication, rate limits, timeout |
| `src/adapters/snapshots.ts` | The gateway's only source of host facts |
| `src/tools/definitions.ts` | The fifteen enabled tools and the deferred registry |
| `src/logging/redact.ts` | Redaction applied to logs, audit records, and tool output |
| `src/logging/audit.ts` | Append-only, rotated audit trail |
| `scripts/collector.py` | The privileged half |
