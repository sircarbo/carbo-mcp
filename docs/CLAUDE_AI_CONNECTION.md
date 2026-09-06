# Connecting Claude.ai

## What you need

| | |
|---|---|
| **Connector URL** | `https://mcp.carbocomputers.com/mcp` |
| **Authentication** | OAuth 2.1, authorization code + PKCE |
| **Sign-in username** | `carbo` |
| **Sign-in password** | in `/opt/carbo-mcp/secrets/keycloak_user_password` |
| **Scopes requested** | the eight `carbo:*:read` scopes |

Read the password without printing it to a shared screen:

```bash
cat /opt/carbo-mcp/secrets/keycloak_user_password
```

## Adding the connector

1. Open **claude.ai** and sign in.
2. Go to **Settings → Connectors**.
3. Click **Add custom connector**.
4. **Name:** `Carbo Server`
5. **Remote MCP server URL:** `https://mcp.carbocomputers.com/mcp`
6. Leave the OAuth Client ID and Client Secret **blank** — Claude registers
   itself, which this realm permits from Claude's callback hosts only.
7. Click **Add**.
8. A browser window opens on a Keycloak page titled **"Sign in to Carbo MCP"**.
   Sign in as `carbo`.
9. A consent screen lists the eight read permissions. Click **Yes / Grant**.
10. The window closes and the connector shows as connected.

### If Claude asks for a Client ID and Secret

Self-registration should work, but if Claude's UI requires them:

- **Client ID:** `claude-ai-connector`
- **Client Secret:** `cat /opt/carbo-mcp/secrets/claude_connector_client_secret`

## Enabling it in a conversation

Start a new conversation, open the tools/connector menu (the toggle beside the
message box), and switch **Carbo Server** on. Connectors are per-conversation —
turning it on once does not enable it everywhere.

## A safe first test prompt

> Using the Carbo Server connector, give me a health summary of carbo-server:
> overall status, CPU, memory, disk, how many containers are running, and
> whether any monitored service is down.

That calls `carbo_get_server_health`, which is read-only and touches nothing.

### What you should get back

Something close to this, phrased naturally:

- **Overall status:** healthy
- **Host:** carbo-server, up about 26 hours
- **CPU:** ~15–25%
- **Memory:** ~48% of 32 GB used
- **Disk:** ~41% on `/`
- **Containers:** 32 running, 0 unhealthy, 2 stopped (two dormant `hello-world`
  containers from seven months ago)
- **Services:** 22 up, 0 down
- **Concerns:** none

Claude should also say the data is roughly a minute or two old rather than a
live reading — every response carries a freshness timestamp.

### More things to try

> What n8n workflows do I have, and which are active?
> Did the Video Factory overnight batch run last night?
> Are my backups current?
> Do I have uncommitted work in any project repository?
> Are all my websites up, and is any TLS certificate expiring soon?
> Has anything been erroring in the last 24 hours?
> Show me the MCP gateway audit summary for today.

### What it will refuse

The connector is read-only. Ask it to restart a container, publish a post, or
run a command and it will tell you it cannot — there is no such tool, at any
permission level. See [TOOLS.md](TOOLS.md).

## Common problems

| Symptom | Cause | Fix |
|---|---|---|
| "Could not connect" straight away | Gateway or Keycloak down | `cd /opt/carbo-mcp && make health` |
| Browser window opens then errors | Keycloak unreachable through nginx | `curl -I https://mcp.carbocomputers.com/realms/carbo/.well-known/openid-configuration` — expect 200 |
| "Account is not fully set up" | The Keycloak user is missing email / first name / last name | See [AUTHENTICATION.md](AUTHENTICATION.md#user-management) |
| "Invalid user credentials" | Wrong password | `cat /opt/carbo-mcp/secrets/keycloak_user_password` |
| Connects, but no tools appear | Token carries no gateway scope | `make audit` — look for `insufficient_scope`; re-run `make configure-keycloak` |
| Tools appear but every call errors | Snapshots stale or missing | `make collect`, then `curl -s http://100.71.174.8:8110/ready` |
| Worked yesterday, fails today | Certificate or token expiry | `make health`; certbot renews automatically, tokens last 900 s and refresh silently |
| 429 responses | Rate limit | 120 requests/minute per user; wait a minute |

More detail in [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Revoking access

**From Claude.ai** — Settings → Connectors → Carbo Server → Remove. This drops
Claude's copy of the tokens.

**From the server** (authoritative; do this if a device is lost):

```bash
cd /opt/carbo-mcp
# 1. Disable the connector client — no new tokens can be issued
docker exec -i carbo-keycloak /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://127.0.0.1:8080 --realm master --user carbo-admin \
  --password "$(cat secrets/keycloak_admin_password)"
docker exec -i carbo-keycloak /opt/keycloak/bin/kcadm.sh update \
  "clients/$(docker exec -i carbo-keycloak /opt/keycloak/bin/kcadm.sh get clients \
     -r carbo -q clientId=claude-ai-connector --fields id --format json \
     | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')" \
  -r carbo -s enabled=false

# 2. Or stop the gateway entirely — affects nothing else on this server
make stop
```

Existing access tokens expire within 900 seconds. To end sessions immediately,
use **Sessions → Sign out all** in the Keycloak admin console over Tailscale
(`http://100.71.174.8:8111/admin/`).
