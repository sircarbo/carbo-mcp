# Reverse proxy

## Important: there is no Nginx Proxy Manager

The brief specified Nginx Proxy Manager. Discovery found none — not on
carbo-server, the Linode VPS, the WordPress Linode, the Raspberry Pi, or EC2.
The public reverse proxy is **stock nginx 1.24.0 with Certbot** on the Linode
VPS (`srv1312203`, 76.13.113.165, Ubuntu 24.04), which already fronts
`term.carbocomputers.com`, `carbo-server.carbocomputers.com`, and
`phone.carbocomputers.com`.

`mcp.carbocomputers.com` resolves to **76.13.113.165** — the VPS, not
carbo-server. carbo-server's own public address is residential (47.201.160.3)
and UFW denies inbound 80/443, so the VPS is the only way in regardless.

The gateway was therefore configured on the actual nginx. **NPM-equivalent
values are given at the bottom** in case you add NPM later.

---

## Deployed configuration

**File:** `/etc/nginx/sites-available/mcp.carbocomputers.com` on the VPS
(symlinked into `sites-enabled/`)
**Shared snippet:** `/etc/nginx/snippets/carbo-mcp-proxy.conf`
**Rate zones:** `/etc/nginx/conf.d/carbo-mcp-limits.conf`
**Backup taken before any change:** `/root/nginx-backups/nginx-config-20260905-155048.tar.gz`

### Routing

| Path | Upstream | Notes |
|---|---|---|
| `/mcp` (exact) | `100.71.174.8:8110` | Buffering off, 600 s timeouts, chunked encoding, 10 r/s burst 20 |
| `/health`, `/ready` | `100.71.174.8:8110` | |
| `/.well-known/oauth-protected-resource*` | `100.71.174.8:8110` | RFC 9728 discovery |
| `/realms/*` | `100.71.174.8:8111` | Keycloak OAuth surface; 5 r/s burst 20 |
| `/resources/*`, `/js/*` | `100.71.174.8:8111` | Login page assets |
| `/.well-known/oauth-authorization-server*` | `100.71.174.8:8111` | RFC 8414 discovery |
| `/.well-known/openid-configuration*` | `100.71.174.8:8111` | |
| `/admin/*`, `/metrics/*`, `/health/*` | — | **404**. Keycloak's admin console is not published |
| everything else | — | **404**, no directory listing, no server version |

### TLS

| Setting | Value |
|---|---|
| Certificate | Let's Encrypt, `mcp.carbocomputers.com`, expires 2026-12-04 |
| Renewal | Certbot's existing scheduled task, already running twice daily |
| HTTP → HTTPS | 301, permanent |
| HTTP/2 | enabled (as a `listen` parameter — nginx 1.24 predates `http2 on;`) |
| HSTS | `max-age=31536000; includeSubDomains`, enabled after HTTPS was verified |
| Ciphers | Certbot's `options-ssl-nginx.conf` plus `ssl-dhparams.pem` |

### Streamable HTTP settings

```nginx
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_buffering off;
proxy_request_buffering off;
proxy_cache off;
chunked_transfer_encoding on;
proxy_read_timeout 600s;
proxy_send_timeout 600s;
```

Buffering off is what allows a streamed response to reach the client as it is
produced; the long read timeout stops a slow tool call being cut off. No
WebSocket upgrade is configured because Streamable HTTP does not use one — it is
plain HTTP POST with an optionally long-lived response.

### Headers

Forwarded: `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`,
`X-Forwarded-Host`. The gateway trusts exactly one hop
(`MCP_TRUST_PROXY_HOPS=1`), so `X-Forwarded-For` cannot be spoofed into the rate
limiter's key. Keycloak runs with `KC_PROXY_HEADERS=xforwarded`.

Added: HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`server_tokens off`. The upstream's copies of the latter two are hidden with
`proxy_hide_header` so they are not sent twice.

### Limits

```nginx
client_max_body_size 1m;     # the gateway itself caps at 256 KB
client_body_timeout 30s;
limit_req_zone $binary_remote_addr zone=carbo_mcp:10m  rate=10r/s;
limit_req_zone $binary_remote_addr zone=carbo_auth:10m rate=5r/s;
```

### Logs

`/var/log/nginx/carbo-mcp.access.log` and `carbo-mcp.error.log`, covered by the
VPS's existing logrotate.

---

## Editing it

```bash
ssh root@76.13.113.165        # or root@100.94.212.114 over Tailscale
vi /etc/nginx/sites-available/mcp.carbocomputers.com
nginx -t                       # ALWAYS test first
systemctl reload nginx         # reload, never restart — other vhosts are live
```

`nginx -t` failing leaves the running configuration untouched. That is what
happened during deployment when `http2 on;` was rejected by nginx 1.24, and no
existing site was affected.

---

## If you move to Nginx Proxy Manager

NPM cannot express path-based routing to two different upstreams in its main
form, so **two proxy hosts on the same domain will not work**. Use one proxy
host pointing at the gateway and put the Keycloak routing in the Advanced tab.

### Proxy host

| Field | Value |
|---|---|
| Domain Names | `mcp.carbocomputers.com` |
| Scheme | `http` |
| Forward Hostname / IP | `100.71.174.8` |
| Forward Port | `8110` |
| Cache Assets | **off** |
| Block Common Exploits | **on** |
| Websockets Support | on (harmless; Streamable HTTP does not use it) |
| Access List | Publicly Accessible |

### SSL tab

| Field | Value |
|---|---|
| SSL Certificate | Request a new certificate (Let's Encrypt) |
| Force SSL | **on** |
| HTTP/2 Support | **on** |
| HSTS Enabled | **on** — only after HTTPS is confirmed working |
| HSTS Subdomains | on |
| Email | `info@carbocomputers.com` |

### Advanced tab

```nginx
client_max_body_size 1m;

location = /mcp {
    proxy_pass http://100.71.174.8:8110;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection        "";
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_cache off;
    chunked_transfer_encoding on;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
}

location ~ ^/(admin|metrics)/ { return 404; }

location ^~ /realms/ {
    proxy_pass http://100.71.174.8:8111;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
location ^~ /resources/ { proxy_pass http://100.71.174.8:8111; proxy_set_header Host $host; }
location ^~ /js/        { proxy_pass http://100.71.174.8:8111; proxy_set_header Host $host; }
location ^~ /.well-known/oauth-authorization-server { proxy_pass http://100.71.174.8:8111; proxy_set_header Host $host; }
location ^~ /.well-known/openid-configuration       { proxy_pass http://100.71.174.8:8111; proxy_set_header Host $host; }
```

NPM would also have to run somewhere that can reach `100.71.174.8` — meaning on
the tailnet. Note that NPM's own database is not to be edited directly; use its
UI.
