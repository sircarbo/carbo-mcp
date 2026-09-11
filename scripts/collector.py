#!/usr/bin/env python3
"""
Carbo MCP Gateway -- host snapshot collector.

This is the only privileged component in the design. It runs on the host under
systemd, gathers exactly the facts the read-only MCP tools need, sanitizes
them, and writes JSON snapshots that the gateway container mounts read-only.

That split is the whole point of the architecture: the container that faces the
internet has no Docker socket, no host filesystem, no database credentials and
no network egress to application ports. It can only read what this script has
already decided is safe to publish.

Rules this script holds itself to:
  * read-only. It never writes outside its own snapshot directory, never
    restarts anything, and never issues a mutating Docker or SQL statement.
  * allowlisted probes. Only the endpoints in SERVICE_CATALOGUE and
    WEBSITE_CATALOGUE are contacted. Vaultwarden and every database port are
    absent by design and must stay that way. wetty is probed for liveness
    only (added 2026-09-11 at Carbo's request); it is never proxied.
  * sanitize on the way out. Log text is pattern-reduced and scrubbed before it
    is written; no raw log line, credential, or record body reaches a snapshot.
  * never fail loudly enough to matter. A broken collector degrades individual
    snapshots to "unavailable"; it does not take down the gateway.

Standard library only -- no third-party dependency is introduced on the host.
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

SNAPSHOT_DIR = Path(os.environ.get("CARBO_MCP_SNAPSHOT_DIR", "/opt/carbo-mcp/data/snapshots"))
PROBE_TIMEOUT = 4.0
DOCKER = "/usr/bin/docker"

# ---------------------------------------------------------------- catalogues

# Only these local endpoints are ever contacted. Adding an entry here is the
# single deliberate act that makes a service visible through the gateway.
SERVICE_CATALOGUE = [
    # id, display name, category, description, container, probe url or None
    ("n8n", "n8n", "automation", "Workflow automation engine", "n8n", "http://127.0.0.1:5678/healthz"),
    ("carbo-design-api", "Carbo Design API", "design", "Carbo Design service backend", "carbo-design-api", "http://127.0.0.1:8101/healthz"),
    ("carbo-design-studio", "Carbo Design Studio", "design", "Carbo Design web interface", "carbo-design-studio", "http://127.0.0.1:8102/"),
    ("carbo-design-mcp", "Carbo Design MCP", "design", "Local MCP server for Carbo Design", "carbo-design-mcp", None),
    ("cd-staging-wp", "Carbo Design staging", "web", "WordPress staging site for Carbo Design", "cd-staging-wp", "http://127.0.0.1:8109/"),
    ("wordpress-local", "WordPress (local)", "web", "Local WordPress instance", "wordpress", "http://127.0.0.1:8080/"),
    ("hbb-admin", "HBB admin dashboard", "web", "Holiday Bail Bonds admin dashboard", "hbb-admin-dashboard", "http://127.0.0.1:8085/"),
    ("dj-music-selector", "DJ Music Selector", "media", "DJ set and track selection tool", "dj-music-selector", "http://127.0.0.1:3000/"),
    ("nextcloud", "Nextcloud", "web", "File sync and share", "nextcloud", "http://127.0.0.1:8087/"),
    ("freshrss", "FreshRSS", "media", "RSS reader", "freshrss", "http://127.0.0.1:8090/"),
    ("gaming-freshrss", "FreshRSS (gaming)", "media", "Gaming news RSS reader", "gaming-freshrss", "http://127.0.0.1:8093/"),
    ("news-ticker", "News ticker", "media", "News ticker feed", "news-ticker", "http://127.0.0.1:8092/"),
    ("gaming-ticker", "Gaming ticker", "media", "Gaming ticker feed", "gaming-ticker", "http://127.0.0.1:8094/"),
    ("sillytavern", "SillyTavern", "ai", "Local AI chat frontend", "sillytavern", "http://127.0.0.1:8096/"),
    ("muse-proxy", "Muse proxy", "infrastructure", "Muse proxy service", "muse-proxy", "http://127.0.0.1:8095/"),
    ("rp-assistant", "RP assistant", "web", "Static assistant site", "carbo-rp-assistant", "http://127.0.0.1:8098/"),
    ("server-monitor", "Server monitor", "monitoring", "Server monitoring dashboard", "carbo-server-monitor", "http://127.0.0.1:30000/"),
    # Liveness of the browser terminal only. The gateway never proxies or reaches it.
    ("wetty", "Web terminal (wetty)", "infrastructure", "Browser SSH terminal to carbo-server, fronted by Apache", "wetty", "http://127.0.0.1:3001/"),
    ("ollama", "Ollama", "ai", "Local large language model runtime", None, "http://127.0.0.1:11434/"),
    ("capcut-mate", "CapCut Mate", "media", "Video editing helper", "capcut-mate", None),
    ("discord-gaming-bot", "Discord gaming bot", "automation", "Daily gaming news Discord bot", "fla-gaming-discord-bot", None),
    ("daily-reports", "Daily reports", "monitoring", "Scheduled daily report generator", "carbo-daily-reports", None),
    ("comprehensive-report", "Comprehensive report", "monitoring", "Infrastructure report generator", "comprehensive-report", None),
]

# Public sites checked for reachability and certificate expiry.
WEBSITE_CATALOGUE = [
    ("carbocomputers.com", "Carbo Computers", "Linode WP"),
    ("boulevardbailbonds.com", "Boulevard Bail Bonds", "Linode WP"),
    ("holidaybailbonds.com", "Holiday Bail Bonds", "Linode WP"),
    ("hotshotbailbonds.com", "Hot Shot Bail Bonds", "Linode WP"),
    ("humblehouseradio.com", "Humble House Radio", "Linode WP"),
    ("mcp.carbocomputers.com", "Carbo MCP Gateway", "Linode VPS"),
]

GIT_PROJECTS = [
    ("carbo-design", "Carbo Design", "/opt/carbo-design"),
    ("factory-v2", "Video Factory v2", "/home/sircarbo/factory_v2"),
    ("carbocomp-site", "Carbo Computers site", "/home/sircarbo/repos/carbocomp-site"),
    ("djcarbo-site", "DJ Carbo site", "/home/sircarbo/repos/djcarbo-site"),
    ("capcut-mate", "CapCut Mate", "/home/sircarbo/docker/capcut-mate"),
]

SECRETS_DIR = Path(os.environ.get("CARBO_MCP_SECRETS_DIR", "/opt/carbo-mcp/secrets"))

# Carbo Design is read through its own REST API with a token scoped to six
# *:read permissions. Going through the API rather than its Postgres means this
# gateway inherits that project's authorisation model instead of reaching
# around it -- and a write is refused by Carbo Design itself, not merely by our
# own good intentions.
CARBO_DESIGN_API = "http://127.0.0.1:8101"
CARBO_DESIGN_TOKEN_FILE = SECRETS_DIR / "carbo_design_api_token"

# Uptime Kuma lives on the EC2 box and is reachable only over Tailscale. Its
# Prometheus endpoint needs an API key; without one the snapshot reports
# "not configured" rather than pretending the monitors are missing.
UPTIME_KUMA_URL = "http://100.69.59.37"
UPTIME_KUMA_KEY_FILE = SECRETS_DIR / "uptime_kuma_api_key"

N8N_SQLITE = "/var/lib/docker/volumes/n8n_n8n_data/_data/database.sqlite"
VF2_ROOT = Path("/home/sircarbo/factory_v2")
VF2_JOBS_DIR = Path("/home/sircarbo/media/vf2_studio_jobs")
SECURITY_LOG_DIR = Path("/opt/security-monitor/logs")
CARBO_DESIGN_BACKUPS = Path("/opt/carbo-design/storage/backups")
DAILY_REPORTS_DIR = Path("/opt/carbo-daily-reports/data")

# ---------------------------------------------------------------- sanitizing

SCRUB_PATTERNS = [
    (re.compile(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), "[redacted]"),
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/-]+=*"), "[redacted]"),
    (re.compile(
        r"(?i)\b([A-Z0-9_.-]*(?:pass(?:word|wd|phrase)?|pwd|secret|token|key|credential|"
        r"auth|cert|salt|signature|session|cookie|bearer))\s*[=:]\s*\S+"
    ), r"\1=[redacted]"),
    # Any SHOUTY_ENV_VAR=value in free text loses its value, keyword or not.
    # Commit subjects and log lines are third-party text: TOS_ACCESS_KEY_ID=...
    # ends in "ID", so a keyword-suffix rule alone would have let it through.
    (re.compile(r"\b([A-Z][A-Z0-9_]{3,})\s*=\s*(\S+)"), r"\1=[redacted]"),
    # Long opaque strings are treated as credentials on sight. A false positive
    # costs a redacted word; a false negative costs a leaked key.
    (re.compile(r"\b[A-Za-z0-9+_-]{40,}={0,2}\b"), "[redacted]"),
    (re.compile(r"(?i)\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"), "[redacted]"),
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "[ip]"),
    (re.compile(r"/(?:home|root|opt|var|etc)/[^\s\"']*"), "[path]"),
]


def scrub(text: str) -> str:
    """Removes anything credential-, identity-, or path-shaped from free text."""
    out = text
    for pattern, replacement in SCRUB_PATTERNS:
        out = pattern.sub(replacement, out)
    return out.strip()


NORMALIZE_PATTERNS = [
    (re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I), "<uuid>"),
    (re.compile(r"\b[0-9a-f]{16,}\b", re.I), "<hex>"),
    (re.compile(r"\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*"), "<timestamp>"),
    (re.compile(r"\b\d+\b"), "<n>"),
]


def normalize(line: str) -> str:
    """Collapses a log line to a pattern so occurrences can be counted."""
    out = scrub(line)
    for pattern, replacement in NORMALIZE_PATTERNS:
        out = pattern.sub(replacement, out)
    return " ".join(out.split())[:200]


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def iso(ts: float | None) -> str | None:
    if not ts:
        return None
    return datetime.fromtimestamp(ts, timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def run(cmd: list[str], timeout: float = 15.0, merge_stderr: bool = False) -> str:
    """Runs a fixed command. Never takes a caller-supplied string through a shell."""
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False, shell=False
        )
        if result.returncode != 0:
            return ""
        return result.stdout + (result.stderr if merge_stderr else "")
    except (subprocess.TimeoutExpired, OSError):
        return ""


def write_snapshot(name: str, data) -> None:
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"collected_at": now_iso(), "data": data}
    tmp = SNAPSHOT_DIR / f".{name}.json.tmp"
    final = SNAPSHOT_DIR / f"{name}.json"
    # Write-then-rename so a reader never sees a half-written file.
    tmp.write_text(json.dumps(payload, separators=(",", ":")))
    os.chmod(tmp, 0o644)
    tmp.replace(final)


# ------------------------------------------------------------------- system


def collect_system() -> dict:
    uname = os.uname()
    with open("/proc/uptime") as fh:
        uptime = float(fh.read().split()[0])

    load1, load5, load15 = os.getloadavg()
    cores = os.cpu_count() or 1

    meminfo: dict[str, int] = {}
    with open("/proc/meminfo") as fh:
        for line in fh:
            key, _, rest = line.partition(":")
            meminfo[key] = int(rest.strip().split()[0])  # kB

    total_mb = meminfo.get("MemTotal", 0) // 1024
    avail_mb = meminfo.get("MemAvailable", 0) // 1024
    used_mb = total_mb - avail_mb
    swap_total_mb = meminfo.get("SwapTotal", 0) // 1024
    swap_free_mb = meminfo.get("SwapFree", 0) // 1024
    swap_used_mb = swap_total_mb - swap_free_mb

    # Sample /proc/stat twice for an instantaneous CPU figure. Load average
    # alone answers a different question and is reported separately.
    def cpu_times() -> tuple[int, int]:
        with open("/proc/stat") as fh:
            parts = [int(x) for x in fh.readline().split()[1:]]
        idle = parts[3] + (parts[4] if len(parts) > 4 else 0)
        return sum(parts), idle

    t1, i1 = cpu_times()
    time.sleep(0.4)
    t2, i2 = cpu_times()
    dt, di = t2 - t1, i2 - i1
    cpu_percent = round(100.0 * (dt - di) / dt, 1) if dt > 0 else 0.0

    disks = []
    for mount in ("/", "/home", "/mnt/my-passport", "/mnt/music-folder"):
        try:
            if not os.path.ismount(mount) and mount != "/":
                continue
            usage = shutil.disk_usage(mount)
        except OSError:
            continue
        disks.append(
            {
                "mount": mount,
                "filesystem": "",
                "totalGb": round(usage.total / 1e9, 1),
                "usedGb": round(usage.used / 1e9, 1),
                "availableGb": round(usage.free / 1e9, 1),
                "usedPercent": round(100.0 * usage.used / usage.total, 1) if usage.total else 0.0,
            }
        )

    os_name = ""
    try:
        for line in Path("/etc/os-release").read_text().splitlines():
            if line.startswith("PRETTY_NAME="):
                os_name = line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass

    return {
        "hostname": uname.nodename,
        "os": os_name or uname.sysname,
        "kernel": uname.release,
        "architecture": uname.machine,
        "uptimeSeconds": int(uptime),
        "loadAverage": {"one": round(load1, 2), "five": round(load5, 2), "fifteen": round(load15, 2)},
        "cpu": {"cores": cores, "usagePercent": cpu_percent},
        "memory": {
            "totalMb": total_mb,
            "usedMb": used_mb,
            "availableMb": avail_mb,
            "usedPercent": round(100.0 * used_mb / total_mb, 1) if total_mb else 0.0,
        },
        "swap": {
            "totalMb": swap_total_mb,
            "usedMb": swap_used_mb,
            "usedPercent": round(100.0 * swap_used_mb / swap_total_mb, 1) if swap_total_mb else 0.0,
        },
        "disks": disks,
    }


# ---------------------------------------------------------------- containers


def collect_containers() -> list[dict]:
    names = [n for n in run([DOCKER, "ps", "-a", "--format", "{{.Names}}"]).splitlines() if n]
    if not names:
        return []

    raw = run([DOCKER, "inspect", *names], timeout=30.0)
    try:
        inspected = json.loads(raw) if raw else []
    except json.JSONDecodeError:
        return []

    out = []
    for item in inspected:
        state = item.get("State", {}) or {}
        host_cfg = item.get("HostConfig", {}) or {}
        ports = (item.get("NetworkSettings", {}) or {}).get("Ports", {}) or {}

        published = []
        for container_port, bindings in ports.items():
            for binding in bindings or []:
                host_ip = binding.get("HostIp", "")
                host_port = binding.get("HostPort", "")
                if host_port:
                    published.append(f"{host_ip or '0.0.0.0'}:{host_port}->{container_port}")

        out.append(
            {
                "name": (item.get("Name") or "").lstrip("/"),
                "image": (item.get("Config", {}) or {}).get("Image", ""),
                "state": state.get("Status", "unknown"),
                "health": ((state.get("Health") or {}).get("Status") or "none"),
                "status": _status_text(state),
                "restartPolicy": (host_cfg.get("RestartPolicy", {}) or {}).get("Name", "no"),
                "restartCount": item.get("RestartCount", 0),
                "startedAt": state.get("StartedAt"),
                "publishedPorts": sorted(set(published)),
            }
        )
    return sorted(out, key=lambda c: c["name"])


def _status_text(state: dict) -> str:
    status = state.get("Status", "unknown")
    started = state.get("StartedAt")
    if status != "running" or not started:
        return status
    try:
        began = datetime.fromisoformat(started.replace("Z", "+00:00"))
        hours = (datetime.now(timezone.utc) - began).total_seconds() / 3600
        if hours < 1:
            return f"Up {int(hours * 60)} minutes"
        if hours < 48:
            return f"Up {int(hours)} hours"
        return f"Up {int(hours / 24)} days"
    except (ValueError, TypeError):
        return status


# ------------------------------------------------------------------- probes


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """
    Turns a redirect into an HTTPError instead of following it.

    This matters for more than tidiness. Nextcloud answers / with a 302 to
    https://nextcloud.carbo.lan/login, so a redirect-following probe would
    leave the allowlist and contact a host nobody approved. Refusing to follow
    keeps every request the collector makes exactly as auditable as the
    catalogue says it is -- and a 3xx already proves the service is answering.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102, ARG002
        return None


_PROBE_OPENER = urllib.request.build_opener(_NoRedirects)


def http_probe(url: str) -> tuple[int | None, int | None]:
    """GETs an allowlisted URL without following redirects. Returns (status, ms)."""
    started = time.monotonic()
    request = urllib.request.Request(url, method="GET", headers={"User-Agent": "carbo-mcp-collector/1.0"})
    try:
        with _PROBE_OPENER.open(request, timeout=PROBE_TIMEOUT) as response:
            response.read(2048)  # Touch the body, keep nothing.
            return response.status, int((time.monotonic() - started) * 1000)
    except urllib.error.HTTPError as err:
        # 3xx, 401 and 403 all prove the service is answering.
        return err.code, int((time.monotonic() - started) * 1000)
    except (urllib.error.URLError, socket.timeout, OSError, ValueError):
        return None, None


def collect_services(containers: list[dict]) -> list[dict]:
    by_name = {c["name"]: c for c in containers}
    checked_at = now_iso()
    out = []

    for sid, name, category, description, container, probe_url in SERVICE_CATALOGUE:
        note = None
        http_status: int | None = None
        response_ms: int | None = None

        if probe_url:
            http_status, response_ms = http_probe(probe_url)
            if http_status is None:
                status = "down"
            elif http_status < 400 or http_status in (401, 403):
                status = "up"
                if http_status in (401, 403):
                    note = "Responding; requires authentication"
                elif 300 <= http_status < 400:
                    note = "Responding with a redirect"
            elif http_status < 500:
                status = "degraded"
            else:
                status = "down"
            probe = {"kind": "http", "target": probe_url}
        elif container:
            info = by_name.get(container)
            if info is None:
                status = "unknown"
                note = "Container not present"
            elif info["state"] != "running":
                status = "down"
            elif info["health"] == "unhealthy":
                status = "degraded"
                note = "Container health check failing"
            else:
                status = "up"
            probe = {"kind": "container", "target": container}
        else:
            status = "unknown"
            probe = {"kind": "none", "target": None}

        # A service can pass its HTTP probe while its container is unhealthy.
        if container and container in by_name and status == "up":
            if by_name[container]["state"] != "running":
                status = "degraded"
                note = "Endpoint answering but container is not running"

        out.append(
            {
                "id": sid,
                "name": name,
                "category": category,
                "description": description,
                "container": container,
                "probe": probe,
                "status": status,
                "httpStatus": http_status,
                "responseTimeMs": response_ms,
                "lastCheckedAt": checked_at,
                "note": note,
            }
        )
    return out


def tls_expiry(domain: str) -> dict | None:
    context = ssl.create_default_context()
    try:
        with socket.create_connection((domain, 443), timeout=PROBE_TIMEOUT) as sock:
            with context.wrap_socket(sock, server_hostname=domain) as tls:
                cert = tls.getpeercert()
    except (ssl.SSLError, socket.gaierror, socket.timeout, OSError):
        return None
    if not cert:
        return None
    not_after = cert.get("notAfter")
    if not not_after:
        return None
    try:
        expires = datetime.strptime(not_after, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    days = (expires - datetime.now(timezone.utc)).days
    return {
        "valid": days > 0,
        "expiresAt": expires.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "daysRemaining": days,
    }


def collect_websites() -> list[dict]:
    checked_at = now_iso()
    out = []
    for domain, label, host in WEBSITE_CATALOGUE:
        status_code, response_ms = http_probe(f"https://{domain}/")
        tls = tls_expiry(domain)
        if status_code is None:
            status = "down"
        elif status_code < 400 or status_code in (401, 403):
            status = "up"
        elif status_code < 500:
            status = "degraded"
        else:
            status = "down"
        if tls and not tls["valid"]:
            status = "degraded"
        out.append(
            {
                "domain": domain,
                "label": label,
                "host": host,
                "status": status,
                "httpStatus": status_code,
                "responseTimeMs": response_ms,
                "tls": tls,
                "lastCheckedAt": checked_at,
            }
        )
    return out


# ---------------------------------------------------------------------- n8n


def read_secret(path: Path) -> str | None:
    """Reads a credential file. Returns None when absent -- never raises."""
    try:
        value = path.read_text().strip()
        return value or None
    except OSError:
        return None


def http_json(url: str, token: str | None = None, timeout: float = 8.0):
    """GETs JSON from an allowlisted URL. Returns None on any failure."""
    headers = {"User-Agent": "carbo-mcp-collector/1.0", "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, method="GET", headers=headers)
    try:
        with _PROBE_OPENER.open(request, timeout=timeout) as response:
            return json.loads(response.read(4_000_000).decode("utf-8", "replace"))
    except (urllib.error.URLError, urllib.error.HTTPError, socket.timeout, OSError, ValueError):
        return None


# --------------------------------------------------------------- carbo design


def collect_design() -> dict:
    empty = {
        "reachable": False,
        "projects": [], "components": [], "sites": [], "publications": [],
        "activity": {"windowHours": 24, "total": 0, "byAction": [], "failures": 0, "lastEventAt": None},
        "counts": {"projects": 0, "components": 0, "componentsPublished": 0,
                   "componentsDraft": 0, "sites": 0, "publications": 0},
    }

    token = read_secret(CARBO_DESIGN_TOKEN_FILE)
    if not token:
        return empty

    health, _ = http_probe(f"{CARBO_DESIGN_API}/healthz")
    if health is None or health >= 500:
        return empty

    projects_raw = http_json(f"{CARBO_DESIGN_API}/api/projects", token) or []
    components_raw = http_json(f"{CARBO_DESIGN_API}/api/components", token) or []
    sites_raw = http_json(f"{CARBO_DESIGN_API}/api/sites", token) or []
    audit_raw = http_json(f"{CARBO_DESIGN_API}/api/audit", token) or []

    projects = [
        {
            "id": str(p.get("id", ""))[:64],
            "slug": scrub(str(p.get("slug") or ""))[:80],
            "name": scrub(str(p.get("name") or ""))[:120],
            "description": scrub(str(p.get("description") or ""))[:200],
            "componentCount": int(p.get("component_count") or 0),
            "updatedAt": p.get("updated_at"),
        }
        for p in projects_raw
        if isinstance(p, dict)
    ][:200]

    by_project = {p["id"]: p["slug"] for p in projects}
    components = [
        {
            "id": str(c.get("id", ""))[:64],
            "slug": scrub(str(c.get("slug") or ""))[:80],
            "name": scrub(str(c.get("name") or ""))[:120],
            "kind": scrub(str(c.get("kind") or ""))[:60],
            "status": str(c.get("status") or "unknown")[:32],
            "projectSlug": c.get("project_slug") or by_project.get(str(c.get("project_id", ""))),
            "latestVersion": c.get("latest_version") if isinstance(c.get("latest_version"), int) else None,
            "updatedAt": c.get("updated_at"),
        }
        for c in components_raw
        if isinstance(c, dict)
    ][:300]

    sites, publications = [], []
    for site in sites_raw:
        if not isinstance(site, dict):
            continue
        slug = str(site.get("slug") or "")
        pubs = http_json(f"{CARBO_DESIGN_API}/api/publications/site/{urllib.parse.quote(slug)}", token) or []
        for pub in pubs if isinstance(pubs, list) else []:
            if not isinstance(pub, dict):
                continue
            publications.append({
                "siteSlug": scrub(slug)[:80],
                "componentSlug": scrub(str(pub.get("component_slug") or ""))[:80],
                "componentName": scrub(str(pub.get("component_name") or "")) [:120] or None,
                "version": pub.get("version") if isinstance(pub.get("version"), int) else None,
                "publishedAt": pub.get("published_at"),
            })
        sites.append({
            "slug": scrub(slug)[:80],
            "name": scrub(str(site.get("name") or ""))[:120],
            "environment": str(site.get("environment") or "unknown")[:32],
            # A base URL is infrastructure, not a secret, but scrub it anyway in
            # case someone ever embeds credentials in one.
            "baseUrl": scrub(str(site.get("base_url") or ""))[:200],
            "isActive": bool(site.get("is_active")),
            "publishedCount": len([p for p in publications if p["siteSlug"] == scrub(slug)[:80]]),
        })

    # Audit is reduced to counts. Actor ids and IP addresses never leave here.
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    actions: dict[str, int] = {}
    failures = 0
    last_at = None
    for entry in audit_raw if isinstance(audit_raw, list) else []:
        if not isinstance(entry, dict):
            continue
        when = entry.get("occurred_at")
        try:
            ts = datetime.fromisoformat(str(when).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            continue
        if ts < cutoff:
            continue
        action = str(entry.get("action") or "unknown")[:60]
        actions[action] = actions.get(action, 0) + 1
        if str(entry.get("outcome") or "").lower() not in ("", "success", "ok"):
            failures += 1
        iso_ts = ts.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        if last_at is None or iso_ts > last_at:
            last_at = iso_ts

    return {
        "reachable": True,
        "projects": projects,
        "components": components,
        "sites": sites,
        "publications": publications[:300],
        "activity": {
            "windowHours": 24,
            "total": sum(actions.values()),
            "byAction": sorted(
                ({"action": a, "count": c} for a, c in actions.items()),
                key=lambda x: x["count"], reverse=True,
            )[:15],
            "failures": failures,
            "lastEventAt": last_at,
        },
        "counts": {
            "projects": len(projects),
            "components": len(components),
            "componentsPublished": len([c for c in components if c["status"] == "published"]),
            "componentsDraft": len([c for c in components if c["status"] != "published"]),
            "sites": len(sites),
            "publications": len(publications),
        },
    }


# ---------------------------------------------------------------- monitoring

# Prometheus exposition lines Uptime Kuma emits, e.g.
#   monitor_status{monitor_name="Foo",monitor_type="http",...} 1
METRIC_RE = re.compile(r"^(?P<metric>[a-z_]+)\{(?P<labels>[^}]*)\}\s+(?P<value>[-0-9.eE+]+)\s*$")
LABEL_RE = re.compile(r'(\w+)="((?:[^"\\]|\\.)*)"')

KUMA_STATUS = {0: "down", 1: "up", 2: "pending", 3: "maintenance"}


def collect_monitoring() -> dict:
    base = {
        "reachable": False,
        "configured": False,
        "note": None,
        "source": "uptime-kuma (EC2, over Tailscale)",
        "monitors": [],
        "counts": {"total": 0, "up": 0, "down": 0, "other": 0},
    }

    key = read_secret(UPTIME_KUMA_KEY_FILE)
    if not key:
        base["note"] = (
            "No Uptime Kuma API key configured. Create one in Uptime Kuma under "
            "Settings > API Keys and save it to secrets/uptime_kuma_api_key."
        )
        return base
    base["configured"] = True

    # Uptime Kuma authenticates /metrics with HTTP Basic: empty user, key as password.
    auth = base64.b64encode(f":{key}".encode()).decode()
    request = urllib.request.Request(
        f"{UPTIME_KUMA_URL}/metrics",
        method="GET",
        headers={"Authorization": f"Basic {auth}", "User-Agent": "carbo-mcp-collector/1.0"},
    )
    try:
        with _PROBE_OPENER.open(request, timeout=10.0) as response:
            body = response.read(4_000_000).decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        base["note"] = f"Uptime Kuma refused the metrics request (HTTP {err.code}). Check the API key."
        return base
    except (urllib.error.URLError, socket.timeout, OSError):
        base["note"] = "Uptime Kuma is not reachable over Tailscale."
        return base

    base["reachable"] = True
    monitors: dict[str, dict] = {}
    for line in body.splitlines():
        match = METRIC_RE.match(line.strip())
        if not match:
            continue
        metric = match.group("metric")
        if metric not in ("monitor_status", "monitor_response_time", "monitor_cert_days_remaining"):
            continue
        labels = dict(LABEL_RE.findall(match.group("labels")))
        name = scrub(labels.get("monitor_name", ""))[:120]
        if not name:
            continue
        try:
            value = float(match.group("value"))
        except ValueError:
            continue

        entry = monitors.setdefault(
            name,
            {"name": name, "status": "unknown", "responseTimeMs": None, "certDaysRemaining": None},
        )
        if metric == "monitor_status":
            entry["status"] = KUMA_STATUS.get(int(value), "unknown")
        elif metric == "monitor_response_time" and value >= 0:
            entry["responseTimeMs"] = int(value)
        elif metric == "monitor_cert_days_remaining":
            entry["certDaysRemaining"] = int(value)

    listed = sorted(monitors.values(), key=lambda m: m["name"])[:200]
    base["monitors"] = listed
    base["counts"] = {
        "total": len(listed),
        "up": len([m for m in listed if m["status"] == "up"]),
        "down": len([m for m in listed if m["status"] == "down"]),
        "other": len([m for m in listed if m["status"] not in ("up", "down")]),
    }
    return base


def collect_n8n() -> dict:
    health_code, _ = http_probe("http://127.0.0.1:5678/healthz")
    reachable = health_code is not None and health_code < 500

    workflows: list[dict] = []
    executions: list[dict] = []
    active_count = 0
    total_count = 0

    src = Path(N8N_SQLITE)
    if src.exists():
        # Copy the database aside before reading. n8n runs in WAL mode; a copy
        # guarantees we never take a lock on or write to the live file.
        tmpdir = tempfile.mkdtemp(prefix="carbo-mcp-n8n-")
        try:
            target = Path(tmpdir) / "db.sqlite"
            for suffix in ("", "-wal", "-shm"):
                candidate = Path(str(src) + suffix)
                if candidate.exists():
                    shutil.copy2(candidate, str(target) + suffix)

            conn = sqlite3.connect(f"file:{target}?mode=ro", uri=True)
            try:
                names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}

                if "workflow_entity" in names:
                    rows = conn.execute(
                        "SELECT id, name, active, updatedAt, nodes FROM workflow_entity "
                        "WHERE COALESCE(isArchived, 0) = 0 ORDER BY updatedAt DESC LIMIT 200"
                    ).fetchall()
                    for wid, wname, active, updated, nodes in rows:
                        node_count = None
                        if nodes:
                            try:
                                parsed = json.loads(nodes)
                                node_count = len(parsed) if isinstance(parsed, list) else None
                            except (json.JSONDecodeError, TypeError):
                                node_count = None
                        workflows.append(
                            {
                                # Names are user-authored; scrub before publishing.
                                "id": str(wid),
                                "name": scrub(str(wname))[:120],
                                "active": bool(active),
                                "updatedAt": str(updated) if updated else None,
                                "nodeCount": node_count,
                            }
                        )
                    total_count = len(workflows)
                    active_count = sum(1 for w in workflows if w["active"])

                if "execution_entity" in names:
                    by_id = {w["id"]: w["name"] for w in workflows}
                    rows = conn.execute(
                        "SELECT id, workflowId, status, startedAt, stoppedAt FROM execution_entity "
                        "WHERE deletedAt IS NULL ORDER BY id DESC LIMIT 100"
                    ).fetchall()
                    for eid, wid, status, started, stopped in rows:
                        duration = None
                        if started and stopped:
                            try:
                                begin = datetime.fromisoformat(str(started).replace("Z", "+00:00"))
                                end = datetime.fromisoformat(str(stopped).replace("Z", "+00:00"))
                                duration = int((end - begin).total_seconds() * 1000)
                            except (ValueError, TypeError):
                                duration = None
                        executions.append(
                            {
                                "id": str(eid),
                                "workflowId": str(wid),
                                "workflowName": by_id.get(str(wid)),
                                "status": str(status or "unknown"),
                                "startedAt": str(started) if started else None,
                                "finishedAt": str(stopped) if stopped else None,
                                "durationMs": duration,
                            }
                        )
            finally:
                conn.close()
        except (sqlite3.Error, OSError):
            pass
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    return {
        "reachable": reachable,
        "healthStatus": "ok" if reachable else None,
        "workflows": workflows,
        "executions": executions,
        "counts": {
            "workflowsTotal": total_count,
            "workflowsActive": active_count,
            "executionsSampled": len(executions),
        },
    }


# ------------------------------------------------------------- video factory


def systemd_property(unit: str, prop: str) -> str:
    out = run(["/usr/bin/systemctl", "show", unit, "-p", prop, "--value"], timeout=8.0)
    return out.strip()


def collect_video() -> dict:
    last_run = systemd_property("vf2-overnight.service", "ExecMainExitTimestamp")
    result = systemd_property("vf2-overnight.service", "Result") or "unknown"
    next_run = systemd_property("vf2-overnight.timer", "NextElapseUSecRealtime")

    jobs: list[dict] = []
    if VF2_JOBS_DIR.is_dir():
        sidecars = sorted(
            VF2_JOBS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True
        )[:50]
        for path in sidecars:
            try:
                blob = json.loads(path.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(blob, dict):
                continue
            error = blob.get("error") or blob.get("error_message")
            jobs.append(
                {
                    "id": str(blob.get("id") or path.stem)[:64],
                    "name": scrub(str(blob.get("name") or ""))[:120] or None,
                    "state": str(blob.get("state") or blob.get("status") or "unknown"),
                    "stage": scrub(str(blob.get("stage") or ""))[:80] or None,
                    "progressPercent": blob.get("progress") if isinstance(blob.get("progress"), (int, float)) else None,
                    "createdAt": blob.get("created_at"),
                    "updatedAt": iso(path.stat().st_mtime),
                    # One sanitized line only -- never a stack trace.
                    "errorSummary": scrub(str(error).splitlines()[0])[:200] if error else None,
                }
            )

    counts: dict[str, int] = {}
    for job in jobs:
        counts[job["state"]] = counts.get(job["state"], 0) + 1

    out_dir = VF2_ROOT / "out"
    output_count = 0
    total_bytes = 0
    latest = None
    if out_dir.is_dir():
        for entry in out_dir.iterdir():
            if entry.is_file() and entry.suffix.lower() in (".mp4", ".mov", ".webm"):
                stat = entry.stat()
                output_count += 1
                total_bytes += stat.st_size
                latest = max(latest or 0, stat.st_mtime)

    return {
        "pipelineName": "Video Factory v2",
        "lastBatchRunAt": last_run or None,
        "lastBatchResult": "success" if result == "success" else ("failed" if result else "unknown"),
        "nextScheduledRunAt": next_run or None,
        "jobs": jobs,
        "outputs": {
            "count": output_count,
            "latestAt": iso(latest),
            "totalSizeMb": round(total_bytes / 1e6, 1),
        },
        "counts": counts,
    }


# ------------------------------------------------------------------ backups


def _dir_backup(job_id, name, schedule, directory: Path, pattern: str, max_age_h: float, retention: str) -> dict:
    files = sorted(directory.glob(pattern), key=lambda p: p.stat().st_mtime, reverse=True) if directory.is_dir() else []
    if not files:
        return {
            "id": job_id, "name": name, "schedule": schedule, "lastRunAt": None,
            "ageHours": None, "status": "missing", "artifactCount": 0,
            "latestArtifactSizeKb": None, "retentionNote": retention,
        }
    newest = files[0].stat()
    age_h = (time.time() - newest.st_mtime) / 3600
    return {
        "id": job_id,
        "name": name,
        "schedule": schedule,
        "lastRunAt": iso(newest.st_mtime),
        "ageHours": round(age_h, 1),
        "status": "ok" if age_h <= max_age_h else "stale",
        "artifactCount": len(files),
        "latestArtifactSizeKb": round(newest.st_size / 1024, 1),
        "retentionNote": retention,
    }


def collect_backups() -> list[dict]:
    return [
        _dir_backup(
            "carbo-design-db", "Carbo Design database backup", "Daily at 02:30",
            CARBO_DESIGN_BACKUPS, "db-*.sql.gz", 26, "30-day retention",
        ),
        _dir_backup(
            "daily-reports", "Daily infrastructure report", "Daily at 07:00",
            DAILY_REPORTS_DIR, "daily-*.log", 26, "Retained on disk",
        ),
        _dir_backup(
            "security-scan", "Nightly security scan", "Daily at 01:00",
            SECURITY_LOG_DIR, "scan-*.log", 26, "Retained on disk",
        ),
    ]


# ----------------------------------------------------------------- projects


def collect_projects() -> list[dict]:
    out = []
    for pid, name, path in GIT_PROJECTS:
        repo = Path(path)
        if not (repo / ".git").exists():
            continue
        base = ["/usr/bin/git", "-c", "safe.directory=*", "-C", path]

        branch = run([*base, "rev-parse", "--abbrev-ref", "HEAD"], timeout=8.0).strip() or None
        porcelain = run([*base, "status", "--porcelain"], timeout=10.0)
        changed = len([line for line in porcelain.splitlines() if line.strip()])

        commit_raw = run([*base, "log", "-1", "--format=%h%x1f%s%x1f%aI"], timeout=8.0).strip()
        last_commit = None
        if commit_raw and "\x1f" in commit_raw:
            sha, subject, authored = (commit_raw.split("\x1f") + ["", "", ""])[:3]
            last_commit = {
                "shortSha": sha[:12],
                "subject": scrub(subject)[:160],
                "authoredAt": authored,
            }

        ahead_behind = None
        counts = run([*base, "rev-list", "--left-right", "--count", "@{upstream}...HEAD"], timeout=8.0).strip()
        if counts:
            parts = counts.split()
            if len(parts) == 2 and all(p.isdigit() for p in parts):
                ahead_behind = {"behind": int(parts[0]), "ahead": int(parts[1])}

        if changed == 0:
            status = "clean"
        elif changed == 1:
            status = "1 uncommitted change"
        else:
            status = f"{changed} uncommitted changes"

        out.append(
            {
                "id": pid,
                "name": name,
                # The path is a stable identifier here, not user data, but the
                # tools never surface it -- it stays for operator debugging.
                "path": path,
                "branch": branch,
                "dirty": changed > 0,
                "changedFileCount": changed,
                "lastCommit": last_commit,
                "aheadBehind": ahead_behind,
                "status": status,
            }
        )
    return out


# ------------------------------------------------------------------- errors


ERROR_RE = re.compile(r"\b(error|exception|failed|failure|fatal|critical|traceback)\b", re.I)
WARN_RE = re.compile(r"\b(warn|warning|deprecated)\b", re.I)


TIMESTAMP_RE = re.compile(
    r"(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)"
)


def line_timestamp(line: str) -> str | None:
    """Best-effort ISO timestamp from a log line. Returns None when absent."""
    match = TIMESTAMP_RE.search(line)
    if not match:
        return None
    text = match.group(1).replace(" ", "T")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _summarize_lines(lines: list[str], window_hours: int, source: str) -> dict:
    errors, warnings = 0, 0
    patterns: dict[str, dict] = {}
    for line in lines:
        is_error = bool(ERROR_RE.search(line))
        is_warn = not is_error and bool(WARN_RE.search(line))
        if not (is_error or is_warn):
            continue
        if is_error:
            errors += 1
        else:
            warnings += 1
        if is_error:
            key = normalize(line)
            if not key:
                continue
            entry = patterns.setdefault(key, {"pattern": key, "count": 0, "lastSeenAt": None})
            entry["count"] += 1
            # Timestamps are read before scrubbing replaced them; keep the latest.
            seen = line_timestamp(line)
            if seen and (entry["lastSeenAt"] is None or seen > entry["lastSeenAt"]):
                entry["lastSeenAt"] = seen
    top = sorted(patterns.values(), key=lambda p: p["count"], reverse=True)[:25]
    return {
        "source": source,
        "windowHours": window_hours,
        "errorCount": errors,
        "warningCount": warnings,
        "topPatterns": top,
    }


def collect_errors() -> dict:
    sources = []

    # Container logs, bounded by both time and line count.
    for container in ("n8n", "carbo-design-api", "wordpress", "nextcloud"):
        raw = run(
            [DOCKER, "logs", "--since", "24h", "--tail", "2000", container],
            timeout=20.0,
            merge_stderr=True,  # container stderr is where the errors are
        )
        if raw:
            sources.append(_summarize_lines(raw.splitlines(), 24, f"container:{container}"))

    vf2_log = VF2_ROOT / "logs" / "vf2.log"
    if vf2_log.is_file():
        try:
            lines = vf2_log.read_text(errors="replace").splitlines()[-2000:]
            sources.append(_summarize_lines(lines, 24, "video-factory"))
        except OSError:
            pass

    security = None
    if SECURITY_LOG_DIR.is_dir():
        scans = sorted(SECURITY_LOG_DIR.glob("scan-*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
        if scans:
            newest = scans[0]
            findings = 0
            severity = None
            try:
                text = newest.read_text(errors="replace")
                findings = len([ln for ln in text.splitlines() if ERROR_RE.search(ln) or "ALERT" in ln.upper()])
                severity = "no findings" if findings == 0 else f"{findings} line(s) flagged for review"
            except OSError:
                pass
            security = {
                "lastRunAt": iso(newest.stat().st_mtime),
                "findingsCount": findings,
                "severitySummary": severity,
            }

    return {"sources": sources, "securityScan": security}


# --------------------------------------------------------------------- main


# ----------------------------------------------------------------- terminal


TERMINAL_URLS = [
    # label, url (probed as-is, so SNI matches the vhost), how it is published.
    # All three are this host's own doors; nothing off-host is contacted.
    ("tailscale", "https://carbo-server.tailca00c8.ts.net:8443/", "Tailscale Serve, trusted certificate, tailnet only"),
    ("apache-port", "https://100.71.174.8:8444/", "Apache on a dedicated port, self-signed certificate, LAN and tailnet"),
    ("apache-name", "https://terminal.carbo.lan/", "Apache by name, self-signed certificate, LAN via Pi-hole DNS"),
]


def _probe_https(url: str, host_header: str | None = None) -> tuple[str, int | None, int | None]:
    """Loopback liveness probe. Self-signed certs are expected, so verification is off."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers={"Host": host_header} if host_header else {})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=PROBE_TIMEOUT, context=ctx) as resp:
            code = resp.status
    except urllib.error.HTTPError as exc:
        code = exc.code
    except Exception:  # noqa: BLE001 - any failure is simply "down"
        return "down", None, None
    ms = int((time.monotonic() - started) * 1000)
    return ("up" if 200 <= code < 400 else "down"), code, ms


def collect_terminal() -> dict:
    """Liveness of the wetty browser terminal and its three doors. Facts only:
    nothing here can open, proxy, or drive the terminal."""
    container = {"state": "absent", "health": "none", "image": None}
    try:
        out = subprocess.run(
            [DOCKER, "inspect", "wetty", "--format",
             "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.Config.Image}}"],
            capture_output=True, text=True, timeout=PROBE_TIMEOUT,
        )
        if out.returncode == 0:
            state, health, image = out.stdout.strip().split("|", 2)
            container = {"state": state, "health": health, "image": image.split("@")[0]}
    except Exception:  # noqa: BLE001
        pass

    backend_status, backend_code, backend_ms = _probe_https("http://127.0.0.1:3001/")

    serve_active = False
    try:
        out = subprocess.run(["tailscale", "serve", "status"], capture_output=True, text=True, timeout=PROBE_TIMEOUT)
        serve_active = ":8443" in out.stdout and "127.0.0.1:3001" in out.stdout
    except Exception:  # noqa: BLE001
        pass

    doors = []
    for label, url, note in TERMINAL_URLS:
        if label == "tailscale" and not serve_active:
            status, code, ms = "down", None, None
        else:
            status, code, ms = _probe_https(url)
        doors.append({"id": label, "url": url, "status": status, "httpStatus": code, "responseTimeMs": ms, "note": note})

    watchdog = {"timerActive": False, "lastResult": None, "lastRunAt": None}
    try:
        out = subprocess.run(["systemctl", "is-active", "wetty-watchdog.timer"], capture_output=True, text=True, timeout=PROBE_TIMEOUT)
        watchdog["timerActive"] = out.stdout.strip() == "active"
        out = subprocess.run(["systemctl", "show", "wetty-watchdog.service", "-p", "Result", "-p", "ExecMainExitTimestamp", "--value"],
                             capture_output=True, text=True, timeout=PROBE_TIMEOUT)
        lines = [l for l in out.stdout.splitlines() if l.strip()]
        if lines:
            watchdog["lastResult"] = lines[0].strip() or None
            if len(lines) > 1 and lines[1].strip():
                try:
                    watchdog["lastRunAt"] = datetime.strptime(lines[1].strip(), "%a %Y-%m-%d %H:%M:%S %Z").astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                except ValueError:
                    watchdog["lastRunAt"] = lines[1].strip()
    except Exception:  # noqa: BLE001
        pass

    recent = []
    try:
        log = Path("/var/log/wetty-watchdog.log")
        if log.exists():
            for line in log.read_text(errors="replace").splitlines()[-5:]:
                recent.append(sanitize_text(line)[:160] if "sanitize_text" in globals() else line[:160])
    except Exception:  # noqa: BLE001
        pass

    any_door_up = any(d["status"] == "up" for d in doors)
    if backend_status == "up" and any_door_up:
        overall = "up" if all(d["status"] == "up" for d in doors) else "degraded"
    elif backend_status == "up":
        overall = "degraded"
    else:
        overall = "down"

    return {
        "overall": overall,
        "container": container,
        "backend": {"status": backend_status, "httpStatus": backend_code, "responseTimeMs": backend_ms},
        "tailscaleServeActive": serve_active,
        "doors": doors,
        "watchdog": watchdog,
        "recentWatchdogEvents": recent,
        "sshTarget": "sircarbo@10.0.0.39 (password authentication, host key pinned)",
    }


def main() -> int:
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)

    collectors = [
        ("system", collect_system),
        ("containers", collect_containers),
        ("websites", collect_websites),
        ("n8n", collect_n8n),
        ("video", collect_video),
        ("backups", collect_backups),
        ("projects", collect_projects),
        ("errors", collect_errors),
        ("design", collect_design),
        ("monitoring", collect_monitoring),
        ("terminal", collect_terminal),
    ]

    containers: list[dict] = []
    failures = []
    for name, fn in collectors:
        try:
            data = fn()
            if name == "containers":
                containers = data
            write_snapshot(name, data)
        except Exception as exc:  # noqa: BLE001 - one bad collector must not stop the rest
            failures.append(f"{name}: {type(exc).__name__}")

    # Services depend on the container snapshot, so it runs last.
    try:
        write_snapshot("services", collect_services(containers))
    except Exception as exc:  # noqa: BLE001
        failures.append(f"services: {type(exc).__name__}")

    if failures:
        print(f"collector completed with failures: {', '.join(failures)}", file=sys.stderr)
        return 1
    print(f"collector wrote {len(collectors) + 1} snapshots to {SNAPSHOT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
