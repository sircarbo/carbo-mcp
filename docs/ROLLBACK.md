# Rollback

Four levels, smallest first. Every one is scoped to this stack — none affects
the 29 unrelated containers on carbo-server.

---

## 1. Roll the gateway back to the previous image

Use when a new gateway build misbehaves. Keycloak keeps running and keeps its
sessions, so nobody has to sign in again.

```bash
cd /opt/carbo-mcp
make rollback
```

This tags the current image as `carbo-mcp-gateway:rolled-back-<stamp>`, restores
`carbo-mcp-gateway:previous` as `:1.0.0`, recreates **only** the gateway
container (`--no-deps`), and waits for it to report healthy.

It requires a `carbo-mcp-gateway:previous` tag. Create one before every deploy:

```bash
docker tag carbo-mcp-gateway:1.0.0 carbo-mcp-gateway:previous
```

## 2. Stop the stack

Use when something is wrong and you want the connector off the air while you
think. Everything else on the server keeps running.

```bash
cd /opt/carbo-mcp
make stop        # stops carbo-mcp, carbo-keycloak, carbo-keycloak-db only
```

Claude.ai will report the connector as unavailable. Nothing is lost — the
Keycloak database and the audit log persist.

Restart with `make start`.

## 3. Restore configuration and the Keycloak realm from a backup

Use after a bad configuration change, or on a rebuilt host.

```bash
cd /opt/carbo-mcp
ls backups/

# a) configuration, source and docs
tar -xzf backups/carbo-mcp-config-<stamp>.tar.gz

# b) secrets (restores mode 0700 secrets/ with 0600 files inside)
tar -xzf backups/carbo-mcp-secrets-<stamp>.tar.gz
# Compose bind-mounts secret files verbatim, so Keycloak's two must stay
# readable by uid/gid 1000:
sudo chgrp 1000 secrets/keycloak_db_password secrets/keycloak_admin_password
sudo chmod 0640 secrets/keycloak_db_password secrets/keycloak_admin_password

# c) the Keycloak database
make stop
docker compose --env-file .env up -d carbo-keycloak-db
sleep 15
gunzip -c backups/keycloak-db-<stamp>.sql.gz \
  | docker compose --env-file .env exec -T carbo-keycloak-db psql -U keycloak -d keycloak

make build && make start && make health
```

If the realm is intact but its configuration drifted, this is usually enough on
its own:

```bash
make configure-keycloak      # idempotent; creates only what is missing
```

## 4. Remove the deployment entirely

Use when you want the gateway gone. Ordered so nothing is left half-removed.

### a. Take the public endpoint down first

```bash
ssh root@100.94.212.114
rm -f /etc/nginx/sites-enabled/mcp.carbocomputers.com
nginx -t && systemctl reload nginx      # test first; a failed test changes nothing
```

Optional — the certificate is harmless if left, and keeping it avoids a fresh
rate-limited issuance if you change your mind:

```bash
certbot delete --cert-name mcp.carbocomputers.com
rm -f /etc/nginx/sites-available/mcp.carbocomputers.com \
      /etc/nginx/snippets/carbo-mcp-proxy.conf \
      /etc/nginx/conf.d/carbo-mcp-limits.conf
nginx -t && systemctl reload nginx
```

To restore the VPS's nginx exactly as it was before this project:

```bash
tar -xzf /root/nginx-backups/nginx-config-20260905-155048.tar.gz -C /
nginx -t && systemctl reload nginx
```

### b. Stop the collector

```bash
sudo systemctl disable --now carbo-mcp-collector.timer
sudo rm -f /etc/systemd/system/carbo-mcp-collector.{service,timer}
sudo systemctl daemon-reload
```

### c. Remove the stack

```bash
cd /opt/carbo-mcp
make backup                                   # last chance to keep the realm
docker compose --env-file .env down           # this project only
```

`docker compose down` here removes only this project's three containers and its
two networks. It does not touch other stacks.

To remove the volumes as well — **this destroys the Keycloak realm, its clients,
and its users**:

```bash
docker compose --env-file .env down -v
```

### d. Remove images and files

```bash
docker rmi carbo-mcp-gateway:1.0.0 carbo-mcp-gateway:previous carbo-keycloak:26.7.3
# Copy backups/ somewhere safe first if you want them.
sudo rm -rf /opt/carbo-mcp
```

### e. Remove the connector from Claude.ai

Settings → Connectors → Carbo Server → Remove.

---

## What removal does **not** touch

Confirmed by construction — this stack shares nothing with anything else on the
host:

- All 29 pre-existing containers, their images, volumes and networks
- Apache and its 12 vhosts on carbo-server
- n8n and its data (read read-only from a copy; never opened live, never written)
- Video Factory v2, its timer, and its outputs
- The security monitor, backups, and daily reports
- Any git repository (read-only `git status` and `git log` only)
- UFW rules — unchanged throughout
- The VPS's other vhosts: `term.`, `carbo-server.`, `phone.carbocomputers.com`

## Verifying after any rollback

```bash
cd /opt/carbo-mcp && make health

# and that nothing else moved:
docker ps --format '{{.Names}}\t{{.Status}}' | grep -vE 'carbo-mcp|carbo-keycloak' | wc -l   # expect 29
```
