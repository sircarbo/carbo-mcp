# Troubleshooting

Start here:

```bash
cd /opt/carbo-mcp && make health
```

It checks containers, the internal endpoints, the public endpoints, the auth
boundary, and the collector, and names whatever failed.

---

## Claude.ai cannot connect at all

```bash
make status                                        # are the three containers up?
curl -s https://mcp.carbocomputers.com/health      # does the public path work?
```

| Result | Meaning | Fix |
|---|---|---|
| Containers down | Stack stopped | `make start` |
| Public 502/504 | nginx cannot reach the gateway over Tailscale | `tailscale status` on both hosts; `ssh root@100.94.212.114 'curl -s -o /dev/null -w "%{http_code}" http://100.71.174.8:8110/health'` |
| Public times out | DNS or the VPS | `dig +short mcp.carbocomputers.com` → must be `76.13.113.165` |
| Certificate error | Renewal failed | `ssh root@100.94.212.114 'certbot certificates'` |

## The OAuth window opens, then fails

```bash
curl -s https://mcp.carbocomputers.com/realms/carbo/.well-known/openid-configuration | head -c 200
```

Expect JSON with `"issuer": "https://mcp.carbocomputers.com/realms/carbo"`.

| Symptom | Cause | Fix |
|---|---|---|
| 404 | nginx `/realms/` location missing | Check `/etc/nginx/sites-enabled/mcp.carbocomputers.com`; `nginx -t && systemctl reload nginx` |
| `issuer` shows an internal address | `KC_HOSTNAME` wrong | Confirm `CARBO_MCP_PUBLIC_ORIGIN` in `.env`, then `make restart` |
| Login page unstyled | `/resources/` not proxied | Same vhost file |
| "Account is not fully set up" | Keycloak user missing email / first name / last name | [AUTHENTICATION.md](AUTHENTICATION.md#user-management) |
| "Invalid user credentials" | Wrong password | `cat secrets/keycloak_user_password` |
| `invalid_redirect_uri` | Claude's callback is not registered | Redirect URIs are pinned to `claude.ai`/`claude.com`; re-run `make configure-keycloak` |

## Connected, but no tools appear

```bash
make audit | tail -20
```

| Audit shows | Meaning | Fix |
|---|---|---|
| `insufficient_scope` | Token carries no gateway scope | `make configure-keycloak`, then reconnect in Claude.ai |
| `invalid_audience` | `aud` is not `https://mcp.carbocomputers.com/mcp` | The audience mapper is missing — `make configure-keycloak` |
| `invalid_issuer` | `iss` mismatch | Compare `OAUTH_ISSUER` in `config/gateway.env` with the realm's actual issuer |
| `subject_not_allowed` | `MCP_ALLOWED_SUBJECTS` excludes this user | Add the subject id or clear the list, then `make restart-gateway` |
| Nothing at all | Requests are not reaching the gateway | Check nginx access log on the VPS |

## Tools appear but every call fails

Almost always stale or missing snapshots.

```bash
curl -s http://100.71.174.8:8110/ready | python3 -m json.tool
systemctl status carbo-mcp-collector.timer
sudo journalctl -u carbo-mcp-collector.service -n 30
```

| Symptom | Fix |
|---|---|
| `"status": "not_ready"`, snapshots stale | `make collect`; if that fixes it, the timer stopped: `sudo systemctl enable --now carbo-mcp-collector.timer` |
| A snapshot shows `unavailable` | The collector partially failed — the journal names which collector threw |
| Collector fails on the n8n snapshot | The n8n volume path changed; check `N8N_SQLITE` in `scripts/collector.py` |

The gateway degrades honestly here: it reports the real age rather than serving
stale data as current.

## A specific tool errors

| Error category | Meaning | Fix |
|---|---|---|
| `unavailable` | The snapshot has never been produced | `make collect` and read the journal |
| `stale_data` | Snapshot older than the tolerance | Check the collector timer |
| `not_found` | The id or domain isn't in the catalogue | Use the matching `list` tool for valid values |
| `invalid_input` | Arguments failed schema validation | Expected — the schema is doing its job |
| `timeout` | Handler exceeded 10 s | Raise `MCP_TOOL_TIMEOUT_MS`, or look for an I/O problem |
| `internal` | Unexpected exception | `make logs` — the full error is logged internally and reduced to this category on the way out |

## Keycloak will not start

```bash
docker logs carbo-keycloak --tail 50
```

| Log line | Cause | Fix |
|---|---|---|
| `bootstrap-admin-username available only when bootstrap admin password is set` | The entrypoint could not read the secret file | `ls -l secrets/` — the two Keycloak secrets must be mode 0640, group gid 1000. Compose bind-mounts them verbatim, so uid 1000 has to be able to read them |
| Database connection refused | Postgres not ready | `docker logs carbo-keycloak-db`; the healthcheck gates startup, so this usually means the DB is genuinely failing |
| `The database is not configured in the build` | The image was not pre-built for Postgres | `make build` — `Dockerfile.keycloak` runs `kc.sh build` |

## Gateway container will not start

```bash
docker logs carbo-mcp --tail 30
```

| Symptom | Cause | Fix |
|---|---|---|
| Exit code 78 with "configuration validation failed" | A required setting is missing or malformed | The log names the exact field; fix `config/gateway.env` |
| `EACCES` writing the audit log | Audit directory ownership | `sudo chown -R 65532:65532 data/audit` |
| Health check failing but the process is up | `/health` not answering | `docker exec` will not work — the image has no shell. Use `curl http://100.71.174.8:8110/health` from the host |

The runtime image is distroless, so there is nothing to exec into. Diagnose from
the outside: logs, the health endpoint, and `docker inspect`.

## Rate limited (429)

120 requests per minute per user, 20 per minute unauthenticated, plus nginx's
10 r/s on `/mcp`. Wait a minute. If it recurs in normal use, raise
`MCP_RATE_LIMIT_MAX` in `config/gateway.env` and `make restart-gateway`.

`make audit` shows `rate_limit` events with the subject responsible.

## Did I break something else on the server?

You did not — but to confirm:

```bash
docker ps --format '{{.Names}}\t{{.Status}}' | grep -v carbo-mcp | grep -v carbo-keycloak
```

All 29 pre-existing containers should be running with zero restarts. Nothing in
this stack shares a network, volume, or port with any of them.

For nginx on the VPS: `nginx -t` failing leaves the running config untouched, so
a bad edit cannot take other sites down. A backup of the entire `/etc/nginx`
tree from before any change is at
`/root/nginx-backups/nginx-config-20260905-155048.tar.gz`.

## Collecting evidence for a deeper look

```bash
cd /opt/carbo-mcp
make health                                    > /tmp/mcp-diag.txt 2>&1
make status                                   >> /tmp/mcp-diag.txt 2>&1
docker logs carbo-mcp --tail 100              >> /tmp/mcp-diag.txt 2>&1
docker logs carbo-keycloak --tail 50          >> /tmp/mcp-diag.txt 2>&1
sudo journalctl -u carbo-mcp-collector -n 30  >> /tmp/mcp-diag.txt 2>&1
sudo python3 scripts/show-audit.py 40         >> /tmp/mcp-diag.txt 2>&1
```

All of these are already redacted. Skim before sharing anyway.
