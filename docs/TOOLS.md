# Tools

Twenty-one tools, all Level 1 (read-only), all requiring a valid token carrying
the listed scope. Three further Level 3 tools for Kling AI image-to-video exist
but are registered only when deliberately enabled — see
[KLING.md](KLING.md) and the section at the end of this file. Every response includes a `freshness` block (`collected_at`,
`age_seconds`, `fresh`) so answers can be dated rather than implied to be live.

## Classification

| Level | Meaning | In this deployment |
|---|---|---|
| **1** | Read-only. Observes; changes nothing. | **All 21 enabled tools** |
| **2** | Low-risk write. Reversible, non-public. | Designed, not enabled — see below |
| **3** | External or publishing action. Reaches third parties; not silently reversible. | Off by default. Only a tool named in `MCP_ELEVATED_TOOLS` can load; the only candidates are the three `kling_*` tools |
| **4** | Destructive or administrative. | Declared and permanently excluded |

The registry refuses to enable a tool above Level 1: `ToolRegistry.register()`
throws if `risk !== 1 && enabled` unless the tool's name was passed in the
operator-supplied allowlist (`MCP_ELEVATED_TOOLS`, empty by default). Level 4
throws regardless. This is enforced in code, not by convention, and is covered
by tests.

---

## Enabled tools

### Server — scope `carbo:server:read`

| Tool | Returns | Cannot |
|---|---|---|
| `carbo_get_server_health` | One-glance verdict: overall status, CPU/memory/disk pressure, running vs unhealthy container counts, services up/down, a list of concerns | Change anything, restart anything; not a live reading |
| `carbo_get_system_resources` | CPU, cores, load average, memory, swap, per-filesystem disk usage, OS and kernel | Free space, list large files, return any filesystem contents |
| `carbo_list_services` | The monitored service catalogue with up/down verdicts, filterable by category and status | Start or stop anything. Never lists the password manager, the web terminal, or any database |
| `carbo_get_service_health` | One service's HTTP status, response time, backing container state, last check time | Probe an arbitrary host or port — only catalogue entries |
| `carbo_get_recent_error_summary` | Deduplicated error/warning **patterns** with counts and last-seen times, plus the nightly security scan result | Return raw log lines, stack traces, request bodies, credentials, or user IPs. Window capped at 168 hours |

### Docker — scope `carbo:docker:read`

| Tool | Returns | Cannot |
|---|---|---|
| `carbo_list_container_status` | Container name, image, state, health, uptime, restart policy and count, published ports. Filterable by name substring or to unhealthy/stopped/running | Start, stop, restart, or inspect a container. Returns no environment variables, mounts, networks, or logs |

### Websites — scope `carbo:websites:read`

| Tool | Returns | Cannot |
|---|---|---|
| `carbo_list_managed_websites` | Reachability and TLS expiry for the managed sites | Check an arbitrary URL; publish, edit, or deploy |
| `carbo_get_website_status` | One site's reachability and certificate detail | Read page content, change DNS or hosting |

### n8n — scope `carbo:n8n:read`

| Tool | Returns | Cannot |
|---|---|---|
| `carbo_list_n8n_workflows` | Workflow name, active flag, node count, last-modified | Return node parameters, credentials, or run data. Cannot create, edit, activate, deactivate, or execute |
| `carbo_get_n8n_execution_status` | Recent executions with status, start time, duration; filterable by workflow and status | Return the data an execution processed or its stack traces. Cannot re-run, retry, or delete |

n8n's REST API requires an API key that is not configured, and creating one
would have meant changing your n8n. The adapter instead copies the SQLite
database aside and reads it read-only, taking only workflow and execution
metadata. It never opens the live file and never writes.

### Video Factory — scope `carbo:video:read`

| Tool | Returns | Cannot |
|---|---|---|
| `carbo_get_video_factory_status` | Last overnight batch time and result, next scheduled run, job counts by state, rendered output count and size | Queue, start, cancel, or render. Returns no video files or media paths |
| `carbo_list_video_jobs` | Recent jobs with state, stage, progress, and a one-line sanitized failure category | Queue, cancel, retry, or download. Never returns full error output |

### Backups — scope `carbo:backups:read`

| Tool | Returns | Cannot |
|---|---|---|
| `carbo_get_backup_status` | Per job: schedule, last artifact time and age, on-time/overdue verdict, artifact count, latest size | Read, list, download, or restore backup **contents**. Cannot trigger a backup |

### Projects — scope `carbo:projects:read`

| Tool | Returns | Cannot |
|---|---|---|
| `carbo_get_project_status` | Branch, dirty flag and changed-file count, last commit subject and date, ahead/behind counts | Return file contents, diffs, commit bodies, or repository paths. Cannot commit, push, pull, branch, or check out |

### Audit — scope `carbo:audit:read`

| Tool | Returns | Cannot |
|---|---|---|
| `carbo_get_mcp_audit_summary` | Aggregate counts of tool calls by outcome, top tools, distinct subjects, error categories, authentication failures | Return tokens, argument values, or tool responses |

### Carbo Design — scope `carbo:design:read`

Carbo Design is the visual component studio at `/opt/carbo-design` — a different
system from this gateway, which happens to also have "MCP" in its name. These
tools read it through its own REST API with a token holding only its six
`*:read` scopes, so this gateway inherits Carbo Design's authorisation model
rather than reaching around it into its database. Carbo Design refuses a write
from this token itself: `POST /api/projects` returns 403.

| Tool | Returns | Cannot |
|---|---|---|
| `carbo_get_design_status` | Project, component, site and publication counts; published vs draft; per-site published counts | Create, edit, publish or unpublish. Returns no component HTML, CSS or JavaScript |
| `carbo_list_design_components` | Components with kind, status, latest version, owning project, last-modified; filterable by project, status or name | Return component content or rendered output. Cannot create, edit, duplicate, delete or publish |
| `carbo_get_design_publications` | Which components are live on which sites, at which version | Publish, unpublish, roll back or re-pin a version. Publishing in Carbo Design requires a human approval step this gateway cannot satisfy |
| `carbo_get_design_activity` | 24-hour aggregate: event count, top action types, failures, last event time | Return actor identities, IP addresses, request bodies, or what changed |

### Monitoring — scope `carbo:monitoring:read`

Uptime Kuma runs on the AWS EC2 box and probes from *outside* carbo-server, so
it sees outages this server's own probes structurally cannot. Read through its
Prometheus `/metrics` endpoint over Tailscale.

| Tool | Returns | Cannot |
|---|---|---|
| `carbo_get_monitoring_summary` | Up/down/other counts, which monitors are down, TLS certificates expiring inside a threshold | Create, pause, resume or delete a monitor; acknowledge an incident |
| `carbo_list_monitors` | Per-monitor status, last response time, certificate days remaining; filterable by status or name | Return historical uptime series or incident history |

These two require an Uptime Kuma API key at `secrets/uptime_kuma_api_key`. When
it is absent they fail with a clear `unavailable` message naming the four steps
to create one, rather than reporting zero monitors as though all were well —
silently reporting "nothing is down" when monitoring is simply unconfigured
would be the worst possible failure mode for an availability tool.

---

## Guarantees every tool holds

- **Bounded inputs.** Enums, length caps, numeric ranges, and a character-class
  allowlist on identifiers. `name_contains: "n8n; rm -rf /"` and `"$(whoami)"`
  are rejected by the schema, not by the handler.
- **Bounded output.** Lists are limit-capped and report the true match count;
  log patterns are capped in both count and length.
- **Sanitized output.** Everything passes through the redactor on the way out —
  the collector sanitizes first, and the gateway does it again.
- **Timeouts.** 10 seconds by default, enforced with an `AbortController`.
- **Audited.** Every call records subject, client, tool, required scope,
  parameter *shapes* (never values), outcome, duration, and error category.
- **Annotated.** Level 1 tools are advertised with `readOnlyHint: true`,
  `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.
  Annotations derive from the declared risk level, so an elevated tool is
  advertised `readOnlyHint: false`, `openWorldHint: true` automatically.

## Never exposed, at any level

Environment variable values · access tokens · passwords · private keys · cookies
· SSH configuration · Vaultwarden data · the wetty/ttyd terminal · any SQL
console or raw database access · full database records · the Docker control
socket · arbitrary command execution · unrestricted filesystem access · Samba
share contents · full log files · personal or patient data.

---

## Deferred capabilities

Declared in `DEFERRED_TOOLS` in `src/tools/definitions.ts`. None has a handler,
so none can be invoked; a test asserts each is unreachable through the registry.

### Level 2 — could be enabled after narrowing

| Tool | Why deferred | Prerequisites |
|---|---|---|
| `carbo_create_wordpress_draft` | Drafts are reversible and never public, but need a scoped credential and hard caps | Per-site application password with author-only capability; draft status forced server-side; content length caps; audit record |
| `carbo_queue_video_job` | Reversible, but consumes significant CPU and disk | Source-asset allowlist; queue-depth and per-day caps; a matching cancel path |
| `carbo_generate_infrastructure_report` | Trivially reversible, but the useful report shape isn't known yet | Dedicated write-only report volume; size cap and retention |

### Level 3 — not planned

| Tool | Why |
|---|---|
| `carbo_publish_wordpress_post` | Externally visible and not silently reversible. Publishing should stay a deliberate action in the WordPress admin |
| `carbo_send_notification` | Reaches third parties and cannot be recalled. Existing automation already covers the scheduled cases |

### Level 4 — permanently excluded

| Tool | Why |
|---|---|
| `carbo_restart_service` | Would require Docker socket access, which this architecture exists to avoid |
| `carbo_run_command` | A hard architectural exclusion. No shell, terminal, or arbitrary execution will be exposed through this gateway under any configuration |

---

## Opt-in Level 3: Kling AI — scope `carbo:kling:generate`

Not part of the read-only set. Registered only when a Kling credential file is
configured **and** the tool is named in `MCP_ELEVATED_TOOLS`; the scope is
advertised in the resource metadata only then. Full reference, setup and
verification status in [KLING.md](KLING.md).

| Tool | Does | Cannot |
|---|---|---|
| `kling_animate_image` | Submits **one paid** image-to-video job with the supplied image as Kling's starting image and a preservation-oriented prompt; `dry_run` shows the exact job and quota without submitting | Fall back to text-to-video, read outside the approved image directory, accept chat attachments, retry, or submit an identical job within ten minutes without `allow_duplicate` |
| `kling_video_status` | Status, failure reason, result URL, units deducted, and what was submitted | Cancel, modify or resubmit; charge anything |
| `kling_download_video` | Saves a succeeded job's video into the approved output directory and returns the link; idempotent | Write anywhere else, fetch an unfinished job, exceed the size cap, follow a non-https URL |
