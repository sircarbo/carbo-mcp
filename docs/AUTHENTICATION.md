# Authentication

## What was chosen and why

Claude.ai remote connectors require OAuth 2.1. No authorization server existed
on any of your hosts, and a homemade OAuth implementation was off the table —
correctly, since getting one right is a specialist job.

**Keycloak 26.7.3**, self-hosted on carbo-server, was selected because it is the
option with the fewest surprises for this specific client: it publishes RFC 8414
authorization-server metadata at the path-inserted URL Claude derives from the
issuer, supports dynamic client registration, PKCE S256, and token revocation,
and keeps every identity record on your own hardware rather than a third party's.

The gateway itself implements only the **resource server** half of the MCP
authorization spec: it validates tokens and never issues, refreshes, or stores
them.

## Topology

```
Claude.ai
  │ 1. POST /mcp with no token           → 401 + WWW-Authenticate
  │ 2. GET /.well-known/oauth-protected-resource/mcp   (the gateway)
  │      → { resource, authorization_servers: [issuer], scopes_supported }
  │ 3. GET /.well-known/oauth-authorization-server/realms/carbo   (Keycloak)
  │      → authorization, token, jwks, registration, revocation endpoints
  │ 4. browser: authorization code + PKCE S256 → user signs in, consents
  │ 5. POST token endpoint → access token (900 s)
  │ 6. POST /mcp with Bearer token       → 200
  ▼
```

## Realm configuration

| Setting | Value |
|---|---|
| Realm | `carbo` |
| Issuer | `https://mcp.carbocomputers.com/realms/carbo` |
| Resource identifier (`aud`) | `https://mcp.carbocomputers.com/mcp` |
| Access token lifetime | 900 s |
| SSO idle / max | 3600 s / 36000 s |
| Self-registration | disabled |
| Brute-force protection | on — 5 failures, 900 s lockout |
| Admin console | tailnet only (`http://100.71.174.8:8111/admin/`), 404 publicly |

The `master` realm holds only the `carbo-admin` administrator. MCP users live in
`carbo`, so the admin account and the connector population never overlap.

## Scopes

| Scope | Grants |
|---|---|
| `carbo:server:read` | Server health, system resources, service catalogue, error summaries |
| `carbo:docker:read` | Container status |
| `carbo:video:read` | Video Factory status and jobs |
| `carbo:n8n:read` | n8n workflows and executions |
| `carbo:websites:read` | Managed website status |
| `carbo:backups:read` | Backup freshness |
| `carbo:projects:read` | Project repository status |
| `carbo:audit:read` | The gateway's own audit summary |
| `carbo:design:read` | Carbo Design projects, components, publications and activity |
| `carbo:monitoring:read` | Uptime Kuma monitor status |

Each is a real Keycloak client scope with a consent-screen description, so the
approval page names exactly what is being granted. All ten, plus the audience
scope, are **realm default client scopes** — a dynamically registered client
gets the same set as the statically configured one.

### The audience scope

`carbo-mcp-audience` carries an `oidc-audience-mapper` that adds
`https://mcp.carbocomputers.com/mcp` to `aud`. This is what binds a token to
this specific resource: a token minted in the same realm for anything else fails
the gateway's audience check.

## Clients

| Client | Type | Purpose |
|---|---|---|
| `claude-ai-connector` | confidential, PKCE S256 required, consent required | The static path — paste its ID and secret into Claude.ai if self-registration is unavailable |
| *(dynamic)* | created on demand | The normal path — Claude registers itself |

Redirect URIs are restricted to `https://claude.ai/api/mcp/auth_callback` and
`https://claude.com/api/mcp/auth_callback`. A request naming any other
`redirect_uri` is refused with 400 (verified).

The client secret is written to `secrets/claude_connector_client_secret`
(mode 0600) and is never printed.

### Dynamic client registration

Keycloak's anonymous registration is gated by the Trusted Hosts policy, which
this deployment pins to `claude.ai` and `claude.com` with
`client-uris-must-match: true`. Claude can self-register; anything else claiming
a different redirect host cannot.

## Token validation

Enforced in `src/auth/tokenVerifier.ts` on every request:

| Check | Failure code |
|---|---|
| Well-formed JWS | `malformed_token` |
| Signature against Keycloak JWKS (RS256/384/512, ES256/384, PS256 only) | `invalid_signature` |
| `iss` equals the configured issuer | `invalid_issuer` |
| `aud` contains the resource identifier | `invalid_audience` |
| `exp` (30 s clock tolerance) | `expired_token` |
| `nbf` (30 s clock tolerance) | `not_yet_valid` |
| `sub` present, and in `MCP_ALLOWED_SUBJECTS` if that list is set | `subject_not_allowed` |
| At least one gateway scope | 403 `insufficient_scope` |
| Per-tool scope, re-checked in the handler | 403 `insufficient_scope` |

JWKS is cached for 10 minutes with a 30-second cooldown, so a token bearing an
unknown `kid` cannot be used to hammer Keycloak.

13 dedicated tests cover these paths, each minting a genuinely defective token
against a real JWKS served over a real socket.

## User management

The login account is `carbo`. Its password is in
`secrets/keycloak_user_password` (mode 0600).

> Keycloak 26 enables the *Verify Profile* action by default and its user
> profile requires email, first name and last name. An account missing any of
> them is refused every grant with "Account is not fully set up". The `carbo`
> account was completed with `carbo@carbocomputers.com` — change it in the admin
> console if you would rather use a different address.

### Adding a user

Over Tailscale, open `http://100.71.174.8:8111/admin/`, sign in as `carbo-admin`
(password in `secrets/keycloak_admin_password`), switch to the `carbo` realm, and
create the user with **email, first name and last name filled in**. Or:

```bash
cd /opt/carbo-mcp
docker exec -i carbo-keycloak /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://127.0.0.1:8080 --realm master --user carbo-admin \
  --password "$(cat secrets/keycloak_admin_password)"

docker exec -i carbo-keycloak /opt/keycloak/bin/kcadm.sh create users -r carbo \
  -s username=NEWUSER -s enabled=true -s emailVerified=true \
  -s email=NEWUSER@carbocomputers.com -s firstName=First -s lastName=Last

docker exec -i carbo-keycloak /opt/keycloak/bin/kcadm.sh set-password -r carbo \
  --username NEWUSER --new-password 'CHOSEN-PASSWORD'
```

### Revoking access

Disable the user (immediate for new sessions, and existing tokens expire within
900 s):

```bash
docker exec -i carbo-keycloak /opt/keycloak/bin/kcadm.sh update \
  "users/$(docker exec -i carbo-keycloak /opt/keycloak/bin/kcadm.sh get users \
     -r carbo -q username=NEWUSER --fields id --format json \
     | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')" \
  -r carbo -s enabled=false
```

To kill existing sessions immediately, use **Sessions → Sign out all** in the
admin console for that user.

To cut off the connector entirely, disable the `claude-ai-connector` client or
remove it in the admin console.

### Narrowing scopes per user

Today every user in the `carbo` realm receives all eight read scopes. That
matches a single-operator deployment. Two ways to tighten it:

1. **Per-subject allowlist (available now).** Put Keycloak subject ids in
   `MCP_ALLOWED_SUBJECTS` in `config/gateway.env`, then `make restart-gateway`.
   Find a subject id in the audit log or with `kcadm get users -r carbo`.
2. **Per-scope control.** Move the eight scopes from realm *default* to realm
   *optional* client scopes, and assign only the wanted ones as defaults on each
   client. The gateway needs no change: it already filters `tools/list` by the
   scopes actually present, and refuses a zero-scope token.

## Re-applying configuration

`scripts/configure-keycloak.sh` is idempotent — it looks every object up before
creating it, so it is safe to re-run after an upgrade or a restore:

```bash
make configure-keycloak
```

## Verified behaviour

Confirmed on this deployment, 2026-09-05:

- Token carries `iss`, `aud` = `https://mcp.carbocomputers.com/mcp`, all eight
  scopes, 900 s lifetime.
- Login page renders over public HTTPS as "Sign in to Carbo MCP"; the form posts
  back to the public hostname (so `KC_HOSTNAME` is correct) and its CSS loads
  through nginx.
- An unknown `redirect_uri` is refused with 400.
- Unauthenticated and bad-token requests to `/mcp` are refused with 401 and a
  correct `WWW-Authenticate` challenge pointing at the metadata document.
- `/admin/` returns 404 publicly.
