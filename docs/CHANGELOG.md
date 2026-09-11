# Changelog

## 1.2.0 — 2026-09-11

### Added

**Kling AI image-to-video** (`carbo:kling:generate`, Level 3, opt-in) —
`kling_animate_image`, `kling_video_status`, `kling_download_video`. Animates
an existing image through Kling's `POST /v1/videos/image2video`, always sending
the supplied image as the starting frame with a preservation preset (single
shot, locked camera, minimal motion, keep face/style/text/background), then
polls and downloads the result into `data/kling/output/`. Reference, setup and
what remains unverified: `docs/KLING.md`.

This is the first capability above Level 1, so the guard changed shape rather
than disappearing: `ToolRegistry` now takes an explicit allowlist
(`MCP_ELEVATED_TOOLS`, empty by default) and still throws for any other tool
above Level 1, and for Level 4 unconditionally. With the default configuration
nothing is different — no Kling tool, scope advertisement, secret mount or
volume exists until the operator adds `docker-compose.kling.yml`, a credential
file and the allowlist. Annotations and connector instructions now derive from
the risk level, so the tools are advertised as non-read-only and the model is
told generation is paid.

Kling authentication was confirmed against the official reference: an API Key
sent as a Bearer token works for all models; an Access Key / Secret Key pair
works via a caller-signed HS256 JWT on the legacy request design. Both are
supported, from secret files only.

Nothing was submitted to Kling during this change. 189 tests (was 151).


## 1.1.0 — 2026-09-05

### Added

Six tools across two new scopes, taking the gateway from 15 to 21.

**Carbo Design** (`carbo:design:read`) — `carbo_get_design_status`,
`carbo_list_design_components`, `carbo_get_design_publications`,
`carbo_get_design_activity`. Read through Carbo Design's own REST API with a
token scoped to its six `*:read` permissions, created via its
`/api/auth/tokens` endpoint and stored at `secrets/carbo_design_api_token`.

Going through the API rather than its Postgres was deliberate: Carbo Design
models roles, scopes and per-site binding, and reading its database directly
would have bypassed all of that. With the API, a write is refused by Carbo
Design itself — `POST /api/projects` returns 403, verified at deployment — not
merely by this gateway's good intentions. Its publish gate, which requires human
approval, is therefore untouched and unreachable from here.

Component HTML, CSS and JavaScript are never returned. The activity tool
reduces the audit log to counts: no actor identities, no IP addresses, no
detail bodies.

**Monitoring** (`carbo:monitoring:read`) — `carbo_get_monitoring_summary`,
`carbo_list_monitors`. Uptime Kuma on the EC2 box, read through its Prometheus
`/metrics` endpoint over Tailscale. It probes from outside carbo-server, so it
sees outages this server's own probes structurally cannot.

Requires an API key at `secrets/uptime_kuma_api_key`. Uptime Kuma exposes no way
to create one except its UI, so the tools **fail loudly with the four steps to
create it** rather than reporting zero monitors. An availability tool that
silently answers "nothing is down" when it is simply unconfigured would be worse
than one that refuses to answer.

A read-only path through the EC2 host's SQLite file was considered and rejected:
it would have meant giving the collector an SSH key to a remote host, which is a
larger standing capability than the feature is worth.

### Changed

- `scripts/configure-keycloak.sh` now attaches newly added scopes to
  already-registered clients as optional scopes. Dynamic client registration
  fixes a client's scope list at registration time, so without this an existing
  connector could never request a scope added later.
- The same script is now genuinely idempotent. It previously aborted on
  "Protocol mapper exists with same name"; detection is now an exact-name check
  and creation tolerates the mapper already being present. Verified by running
  it three times in a row.
- `scope_id()` passes values to Python through the environment rather than
  interpolating them into its source, and returns only the first match.

### Testing

151 tests, all passing (was 132). 19 new, covering scope assignment, filtering,
the not-found paths, input rejection of shell metacharacters, that component
content and actor identities never appear in output, certificate-threshold
ordering, and that the monitoring tools degrade honestly when unconfigured while
the design tools keep working.

### Note for existing connections

Claude.ai's connector registered before these scopes existed. Reconnect it
(Settings → Connectors → remove and re-add) to pick up the two new scopes;
until then the six new tools will not appear in its tool list.

## 1.0.2 — 2026-09-05

### Added

- **Protocol-level audit events.** `initialize`, `tools/list`, and any protocol
  message the transport rejects before a handler runs are now recorded. The
  `initialize` record carries the connecting client's name and version, and
  every protocol record carries the HTTP status and duration.

  Previously only `tool_call`, `auth_failure` and `rate_limit` were written —
  the `initialize` and `tools_list` event types were declared in the code but
  never emitted. That gap was felt in practice: after the 1.0.1 fix the audit
  log could not answer "did the connector actually connect?", and diagnosing it
  meant reading the reverse proxy's access log instead. It also left Claude.ai's
  protocol-version probe (a 400 the transport returns before any handler sees
  the request) completely invisible.

  Successful notifications and keepalives are deliberately **not** recorded, so
  the log does not fill with noise; a *failing* one is, because that is where a
  protocol mismatch shows up. Tool calls are unchanged — they continue to audit
  themselves from inside the handler wrapper, with more detail, and are not
  double-recorded.

- `carbo_get_mcp_audit_summary` now reports `connections` and `tool_listings`
  alongside the existing counters.
- `scripts/show-audit.py` shows the JSON-RPC method, the connecting client, the
  HTTP status, and the rejected protocol version where there was one.

### Testing

20 new tests (132 total, all passing) covering message parsing, batch handling,
bounding of attacker-controlled client strings, status-to-outcome mapping, and
end-to-end assertions that the records are written, that a tool call is not
double-recorded, that successful notifications produce no record, and that no
token or header value reaches a protocol record.

## 1.0.1 — 2026-09-05

### Fixed

- **Claude.ai connector failed authorization with `invalid_audience`.** The OAuth
  flow completed correctly — dynamic registration, login, consent, and token
  issuance all succeeded — but every `/mcp` call was refused because the issued
  token's `aud` did not contain `https://mcp.carbocomputers.com/mcp`.

  **Cause:** Keycloak's *dynamic* client registration does not apply realm
  default client scopes the way normal client creation does. When the
  registration request names the scopes it wants, Keycloak files those as
  **optional** and reduces the client's defaults to just `basic`. The dedicated
  `carbo-mcp-audience` scope was therefore dropped from the registered client
  entirely — Claude never requests it, because it is not an advertised scope —
  so the audience mapper never ran.

  **Fix:** the audience mapper is now attached to each of the eight
  `carbo:*:read` client scopes as well as to the dedicated audience scope. The
  rule is now self-consistent: if a token grants a Carbo read scope, it is
  addressed to the Carbo gateway, regardless of how the client was created.
  `scripts/configure-keycloak.sh` also repairs any already-registered client by
  attaching the audience scope, so an existing connector recovers without being
  removed and re-added.

  **Verified** by reproducing the exact client shape Keycloak's dynamic
  registration produced (defaults reduced to `basic`, read scopes optional),
  requesting a two-scope subset, and confirming the resulting token carries the
  correct single `aud` and is accepted — with `tools/list` correctly returning
  only the six tools those two scopes authorize.

No gateway code changed. Audience validation was not weakened: the resource
identifier check is unchanged, and a token minted for any other resource is
still refused.

## 1.0.0 — 2026-09-05

First deployment. Read-only MCP gateway for carbo-server, reachable from
Claude.ai at `https://mcp.carbocomputers.com/mcp`.

### Added

- **Gateway** — TypeScript on Node 22, `@modelcontextprotocol/sdk` 1.30.0,
  Streamable HTTP in stateless mode. Endpoints: `/mcp`, `/health`, `/ready`,
  `/.well-known/oauth-protected-resource[/mcp]`.
- **Fifteen Level 1 tools** across eight scopes — server health and resources,
  container status, service catalogue and per-service health, managed websites,
  n8n workflows and executions, Video Factory status and jobs, backup freshness,
  project repository status, sanitized error summaries, and the gateway's own
  audit summary.
- **Seven deferred tool definitions** (Levels 2–4) declared without handlers, so
  the boundary is reviewable in code and none can be invoked.
- **Authentication** — Keycloak 26.7.3 with a Postgres 17.7 backend. Realm
  `carbo`, eight consentable scopes, an audience mapper pinning `aud` to the
  gateway's resource identifier, a confidential Claude connector client with
  PKCE S256, and dynamic client registration restricted to Claude's callback
  hosts.
- **Host collector** — `scripts/collector.py` under a hardened systemd timer,
  refreshing nine sanitized JSON snapshots every two minutes.
- **Hardening** — distroless runtime, uid 65532, read-only root filesystem, all
  capabilities dropped, `no-new-privileges`, no Docker socket, tailnet-only port
  bindings, an `internal` network for the database, CPU and memory limits,
  health checks, and log rotation.
- **Observability** — structured JSON application logs and a separate rotated
  audit trail (16 MB × 14) recording every tool call, authentication failure,
  and rate-limit event with parameter shapes but never values.
- **112 automated tests** — redaction, configuration validation, token
  validation against a real JWKS over a real socket, tool behaviour against
  fixtures, and end-to-end HTTP including every rejection path.
- **Operations** — `Makefile` scoped to this stack, plus `healthcheck.sh`,
  `rollback.sh`, `show-audit.py`, and an idempotent `configure-keycloak.sh`.
- **Reverse proxy** — nginx vhost on the Linode VPS with Let's Encrypt, HSTS,
  HTTP/2, path routing, rate limiting, and Keycloak's admin console returning
  404 publicly.
- **Documentation** — the twelve documents listed in the README.

### Deviations from the brief, and why

| Specified | Delivered | Reason |
|---|---|---|
| Nginx Proxy Manager | stock nginx 1.24 + Certbot on the Linode VPS | No NPM exists on any host. NPM-equivalent values are documented for a future migration |
| Gateway reachable directly at the MCP domain | Reached via the VPS over Tailscale | `mcp.carbocomputers.com` resolves to the VPS; carbo-server is residential with UFW denying inbound 80/443 |
| — | Keycloak deployed on carbo-server | No authorization server existed. Selected and confirmed before deployment |
| Container status via Docker | Via a host collector | Rule 12 forbids mounting the Docker socket in the gateway. The split turned out to be the stronger design |
| n8n via its REST API | Via a read-only copy of its SQLite database | The n8n API needs a key that is not configured; creating one would have meant changing your n8n |

### Defects found and fixed during the build

- **Collector followed HTTP redirects**, contacting `nextcloud.carbo.lan` — a
  host outside the allowlist. Probes no longer follow redirects; a 3xx already
  proves a service is answering.
- **`docker logs` stderr was discarded**, so every error summary read as zero
  even where errors existed. Container stderr is now merged.
- **Redaction missed `SHOUTY_ENV_VAR=value`** where the name did not end in a
  credential keyword — found via a real `TOS_ACCESS_KEY_ID=…` in a commit
  subject. Both redactors now strip any uppercase env-var assignment.
- **Over-redaction hid the JWKS URI** from the startup log, because the
  opaque-blob rule matched URL paths. Tightened to base64url characters.
- **A zero-scope token produced a broken empty `tools/list`.** Such tokens are
  now refused with 403 `insufficient_scope`, which is also the correct answer.
- **IPv6 rate-limit keys were not subnet-masked**, letting an ordinary IPv6
  allocation rotate addresses to evade the limit. Now keyed on /64.
- **Keycloak silently started with no database password**, because Keycloak 26
  ignores `KC_DB_PASSWORD_FILE`. An entrypoint now loads the mounted secrets.
- **Compose bind-mounts secret files verbatim**, so mode 0600 made them
  unreadable by the container's uid. Now 0640, group gid 1000, inside a 0700
  directory.

### Verified at deployment

Public HTTPS with a valid Let's Encrypt certificate; HTTP→HTTPS redirect; HSTS;
protected-resource and authorization-server metadata; the Keycloak login page
and consent screen over public HTTPS; an unknown `redirect_uri` refused with
400; unauthenticated and bad-token `/mcp` refused with 401 and a correct
`WWW-Authenticate` challenge; authenticated `initialize`, `tools/list` (15
tools) and real tool calls returning live server data; the admin console
returning 404 publicly; all 112 tests passing; and all 29 pre-existing
containers still running with zero restarts.

### Known limitations

- Snapshots are up to two minutes old. Every response states its age.
- All realm users receive all eight read scopes; `MCP_ALLOWED_SUBJECTS` is
  available as a per-subject gate, and per-scope narrowing is documented.
- The gateway container has outbound network access via the Docker bridge, which
  port publishing requires. It holds no credentials, has no shell and no package
  manager.
- Trivy is not installed on this host; `make scan` prints a containerised
  alternative.
