/**
 * The Level 1 (read-only) tool set.
 *
 * Design rules applied to every tool here:
 *  - it answers a question an operator actually asks, rather than exposing a
 *    raw data source;
 *  - inputs are bounded (enums, length caps, numeric ranges) so a malformed or
 *    hostile argument is rejected by the schema, not by the handler;
 *  - output is a summary, never a dump: log tails are line-capped, lists are
 *    limit-capped, and nothing carries a credential, a full path, or a record
 *    body;
 *  - every response states how fresh the underlying snapshot is, so the model
 *    can say "as of two minutes ago" instead of implying it is live.
 */
import { z } from 'zod';
import type { SnapshotReader } from '../adapters/snapshots.js';
import { SnapshotUnavailableError } from '../adapters/snapshots.js';
import type { AuditLog } from '../logging/audit.js';
import { redactString } from '../logging/redact.js';
import { ToolError, type DeferredTool, type ToolDefinition } from './registry.js';
import type {
  BackupSnapshot,
  DesignSnapshot,
  MonitoringSnapshot,
  ContainerSnapshot,
  ErrorSummarySnapshot,
  N8nSnapshot,
  ProjectSnapshot,
  ServiceSnapshot,
  SystemSnapshot,
  VideoSnapshot,
  WebsiteSnapshot,
} from '../models/snapshots.js';

/** Freshness block attached to every tool response. */
const Freshness = z.object({
  collected_at: z.string(),
  age_seconds: z.number(),
  fresh: z.boolean(),
});

function envelope<T>(reader: SnapshotReader, name: Parameters<SnapshotReader['read']>[0]) {
  try {
    return reader.read<T>(name);
  } catch (err) {
    if (err instanceof SnapshotUnavailableError) {
      throw new ToolError(
        'unavailable',
        `The ${name} snapshot has not been produced yet. The host collector may not have run.`,
      );
    }
    throw new ToolError('internal', 'Snapshot could not be read.');
  }
}

function freshness(env: { collectedAt: string; ageSeconds: number; fresh: boolean }) {
  return { collected_at: env.collectedAt, age_seconds: env.ageSeconds, fresh: env.fresh };
}

/** Bounded free-text identifier used by lookup-style tools. */
const identifier = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._:/-]+$/, 'may contain letters, digits and . _ : / - only');

export interface ToolDeps {
  snapshots: SnapshotReader;
  audit: AuditLog;
}

/**
 * Identity helper that pins each tool's input type to its own zod schema.
 * Without it the array's element type erases the generic and every handler
 * argument degrades to `unknown`.
 */
function defineTool<T extends z.ZodTypeAny>(def: ToolDefinition<T>): ToolDefinition {
  return def as unknown as ToolDefinition;
}

export function buildTools(deps: ToolDeps): ToolDefinition[] {
  const { snapshots, audit } = deps;
  const tools: ToolDefinition[] = [];

  // ---------------------------------------------------------------- server

  tools.push(defineTool({
    name: 'carbo_get_server_health',
    title: 'Server health overview',
    description:
      'Returns a one-glance health verdict for carbo-server: overall status, CPU/memory/disk pressure, ' +
      'how many containers are running versus unhealthy, and how many monitored services are down. ' +
      'Use this first when asked "how is the server doing". ' +
      'It cannot change anything, cannot restart services, and reports data from the most recent ' +
      'collector run rather than a live measurement taken at call time.',
    scope: 'carbo:server:read',
    risk: 1,
    enabled: true,
    inputSchema: z.object({}),
    outputSchema: z.object({
      overall_status: z.enum(['healthy', 'degraded', 'unhealthy', 'unknown']),
      hostname: z.string(),
      uptime_hours: z.number(),
      cpu_usage_percent: z.number(),
      memory_used_percent: z.number(),
      max_disk_used_percent: z.number(),
      containers: z.object({ running: z.number(), unhealthy: z.number(), stopped: z.number() }),
      services: z.object({ up: z.number(), down: z.number(), unknown: z.number() }),
      concerns: z.array(z.string()),
      freshness: Freshness,
    }),
    handler: async () => {
      const sys = envelope<SystemSnapshot>(snapshots, 'system');
      const containers = envelope<ContainerSnapshot[]>(snapshots, 'containers');
      const services = envelope<ServiceSnapshot[]>(snapshots, 'services');

      const maxDisk = Math.max(0, ...sys.data.disks.map((d) => d.usedPercent));
      const running = containers.data.filter((c) => c.state === 'running').length;
      const unhealthy = containers.data.filter((c) => c.health === 'unhealthy').length;
      const stopped = containers.data.filter((c) => c.state !== 'running').length;
      const up = services.data.filter((s) => s.status === 'up').length;
      const down = services.data.filter((s) => s.status === 'down').length;
      const unknown = services.data.filter((s) => s.status === 'unknown').length;

      const concerns: string[] = [];
      if (sys.data.memory.usedPercent >= 90) concerns.push(`Memory at ${sys.data.memory.usedPercent}%`);
      if (maxDisk >= 85) concerns.push(`Disk at ${maxDisk}%`);
      if (sys.data.cpu.usagePercent >= 90) concerns.push(`CPU at ${sys.data.cpu.usagePercent}%`);
      if (unhealthy > 0) concerns.push(`${unhealthy} container(s) reporting unhealthy`);
      if (down > 0) concerns.push(`${down} monitored service(s) down`);
      if (!sys.fresh) concerns.push(`Snapshot is ${sys.ageSeconds}s old`);

      let overall: 'healthy' | 'degraded' | 'unhealthy' | 'unknown' = 'healthy';
      if (!sys.fresh) overall = 'unknown';
      else if (down > 0 || unhealthy > 0 || maxDisk >= 95 || sys.data.memory.usedPercent >= 95) overall = 'unhealthy';
      else if (concerns.length > 0) overall = 'degraded';

      return {
        overall_status: overall,
        hostname: sys.data.hostname,
        uptime_hours: Math.round((sys.data.uptimeSeconds / 3600) * 10) / 10,
        cpu_usage_percent: sys.data.cpu.usagePercent,
        memory_used_percent: sys.data.memory.usedPercent,
        max_disk_used_percent: maxDisk,
        containers: { running, unhealthy, stopped },
        services: { up, down, unknown },
        concerns,
        freshness: freshness(sys),
      };
    },
  }));

  tools.push(defineTool({
    name: 'carbo_get_system_resources',
    title: 'System resource detail',
    description:
      'Returns detailed CPU, load average, memory, swap and per-filesystem disk usage for carbo-server, ' +
      'plus OS and kernel version. Use when you need the actual numbers rather than a verdict — ' +
      'for capacity questions, "am I running out of disk", or before recommending a cleanup. ' +
      'It cannot free space, cannot list which files are large, and gives no filesystem contents.',
    scope: 'carbo:server:read',
    risk: 1,
    enabled: true,
    inputSchema: z.object({}),
    outputSchema: z.object({
      hostname: z.string(),
      os: z.string(),
      kernel: z.string(),
      architecture: z.string(),
      uptime_hours: z.number(),
      load_average: z.object({ one: z.number(), five: z.number(), fifteen: z.number() }),
      cpu: z.object({ cores: z.number(), usage_percent: z.number() }),
      memory_mb: z.object({ total: z.number(), used: z.number(), available: z.number(), used_percent: z.number() }),
      swap_mb: z.object({ total: z.number(), used: z.number(), used_percent: z.number() }),
      disks: z.array(
        z.object({
          mount: z.string(),
          total_gb: z.number(),
          used_gb: z.number(),
          available_gb: z.number(),
          used_percent: z.number(),
        }),
      ),
      freshness: Freshness,
    }),
    handler: async () => {
      const sys = envelope<SystemSnapshot>(snapshots, 'system');
      const d = sys.data;
      return {
        hostname: d.hostname,
        os: d.os,
        kernel: d.kernel,
        architecture: d.architecture,
        uptime_hours: Math.round((d.uptimeSeconds / 3600) * 10) / 10,
        load_average: d.loadAverage,
        cpu: { cores: d.cpu.cores, usage_percent: d.cpu.usagePercent },
        memory_mb: {
          total: d.memory.totalMb,
          used: d.memory.usedMb,
          available: d.memory.availableMb,
          used_percent: d.memory.usedPercent,
        },
        swap_mb: { total: d.swap.totalMb, used: d.swap.usedMb, used_percent: d.swap.usedPercent },
        disks: d.disks.map((disk) => ({
          mount: disk.mount,
          total_gb: disk.totalGb,
          used_gb: disk.usedGb,
          available_gb: disk.availableGb,
          used_percent: disk.usedPercent,
        })),
        freshness: freshness(sys),
      };
    },
  }));

  // ---------------------------------------------------------------- docker

  tools.push(defineTool({
    name: 'carbo_list_container_status',
    title: 'Docker container status',
    description:
      'Lists Docker containers on carbo-server with state, health check result, uptime, restart policy ' +
      'and restart count. Optionally filter to a name substring or to only unhealthy/stopped containers. ' +
      'Use this to answer "is X running", "what is unhealthy", or "what keeps restarting". ' +
      'It cannot start, stop, restart, or inspect a container; it returns no environment variables, ' +
      'no mounts, no networks and no logs.',
    scope: 'carbo:docker:read',
    risk: 1,
    enabled: true,
    inputSchema: z.object({
      name_contains: identifier.optional().describe('Case-insensitive substring filter on container name.'),
      only: z
        .enum(['all', 'unhealthy', 'stopped', 'running'])
        .default('all')
        .describe('Restrict the result to a subset. Defaults to all containers.'),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    outputSchema: z.object({
      total_matched: z.number(),
      returned: z.number(),
      containers: z.array(
        z.object({
          name: z.string(),
          image: z.string(),
          state: z.string(),
          health: z.string(),
          status: z.string(),
          restart_policy: z.string(),
          restart_count: z.number(),
          published_ports: z.array(z.string()),
        }),
      ),
      freshness: Freshness,
    }),
    handler: async (input) => {
      const env = envelope<ContainerSnapshot[]>(snapshots, 'containers');
      const needle = input.name_contains?.toLowerCase();
      let matched = env.data;
      if (needle) matched = matched.filter((c) => c.name.toLowerCase().includes(needle));
      if (input.only === 'unhealthy') matched = matched.filter((c) => c.health === 'unhealthy');
      else if (input.only === 'stopped') matched = matched.filter((c) => c.state !== 'running');
      else if (input.only === 'running') matched = matched.filter((c) => c.state === 'running');

      const page = matched.slice(0, input.limit);
      return {
        total_matched: matched.length,
        returned: page.length,
        containers: page.map((c) => ({
          name: c.name,
          image: c.image,
          state: c.state,
          health: c.health,
          status: c.status,
          restart_policy: c.restartPolicy,
          restart_count: c.restartCount,
          published_ports: c.publishedPorts,
        })),
        freshness: freshness(env),
      };
    },
  }));

  // --------------------------------------------------------------- services

  tools.push(defineTool({
    name: 'carbo_list_services',
    title: 'Service catalogue',
    description:
      'Lists the applications the gateway monitors on carbo-server — automation, web, media, monitoring, ' +
      'AI and design services — with the current up/down verdict for each. Use it to find out what runs ' +
      'on this server, or as the first step before calling carbo_get_service_health for detail. ' +
      'Deliberately excluded and never listed: the password manager, the web terminal, and any database. ' +
      'It cannot start or stop anything.',
    scope: 'carbo:server:read',
    risk: 1,
    enabled: true,
    inputSchema: z.object({
      category: z
        .enum(['all', 'automation', 'web', 'media', 'monitoring', 'ai', 'design', 'infrastructure'])
        .default('all'),
      status: z.enum(['all', 'up', 'down', 'degraded', 'unknown']).default('all'),
    }),
    outputSchema: z.object({
      total: z.number(),
      services: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          category: z.string(),
          description: z.string(),
          status: z.string(),
          http_status: z.number().nullable(),
          response_time_ms: z.number().nullable(),
          note: z.string().nullable(),
        }),
      ),
      freshness: Freshness,
    }),
    handler: async (input) => {
      const env = envelope<ServiceSnapshot[]>(snapshots, 'services');
      let list = env.data;
      if (input.category !== 'all') list = list.filter((s) => s.category === input.category);
      if (input.status !== 'all') list = list.filter((s) => s.status === input.status);
      return {
        total: list.length,
        services: list.map((s) => ({
          id: s.id,
          name: s.name,
          category: s.category,
          description: s.description,
          status: s.status,
          http_status: s.httpStatus,
          response_time_ms: s.responseTimeMs,
          note: s.note,
        })),
        freshness: freshness(env),
      };
    },
  }));

  tools.push(defineTool({
    name: 'carbo_get_service_health',
    title: 'Single service health',
    description:
      'Returns the health detail for one monitored service by its id, including HTTP status, response time, ' +
      'the backing container state, and when it was last checked. Call carbo_list_services first to get valid ids. ' +
      'It cannot probe an arbitrary host or port — only services in the curated catalogue — and it cannot ' +
      'restart or reconfigure the service.',
    scope: 'carbo:server:read',
    risk: 1,
    enabled: true,
    inputSchema: z.object({
      service_id: identifier.describe('Service id from carbo_list_services.'),
    }),
    outputSchema: z.object({
      id: z.string(),
      name: z.string(),
      category: z.string(),
      description: z.string(),
      status: z.string(),
      http_status: z.number().nullable(),
      response_time_ms: z.number().nullable(),
      container: z
        .object({ name: z.string(), state: z.string(), health: z.string(), restart_count: z.number() })
        .nullable(),
      last_checked_at: z.string(),
      note: z.string().nullable(),
      freshness: Freshness,
    }),
    handler: async (input) => {
      const env = envelope<ServiceSnapshot[]>(snapshots, 'services');
      const service = env.data.find((s) => s.id === input.service_id);
      if (!service) {
        throw new ToolError(
          'not_found',
          `No monitored service with id "${input.service_id}". Call carbo_list_services for valid ids.`,
        );
      }
      let container = null;
      if (service.container) {
        const containers = envelope<ContainerSnapshot[]>(snapshots, 'containers');
        const c = containers.data.find((x) => x.name === service.container);
        if (c) {
          container = { name: c.name, state: c.state, health: c.health, restart_count: c.restartCount };
        }
      }
      return {
        id: service.id,
        name: service.name,
        category: service.category,
        description: service.description,
        status: service.status,
        http_status: service.httpStatus,
        response_time_ms: service.responseTimeMs,
        container,
        last_checked_at: service.lastCheckedAt,
        note: service.note,
        freshness: freshness(env),
      };
    },
  }));

  // --------------------------------------------------------------- websites

  tools.push(defineTool({
    name: 'carbo_list_managed_websites',
    title: 'Managed websites',
    description:
      'Lists the public websites managed from this infrastructure with their reachability and TLS ' +
      'certificate expiry. Use it for "are my sites up" and "is any certificate about to expire". ' +
      'It reports on the sites in the managed catalogue only, cannot check an arbitrary URL, and ' +
      'cannot publish, edit, or deploy anything.',
    scope: 'carbo:websites:read',
    risk: 1,
    enabled: true,
    inputSchema: z.object({
      status: z.enum(['all', 'up', 'down', 'degraded', 'unknown']).default('all'),
    }),
    outputSchema: z.object({
      total: z.number(),
      sites: z.array(
        z.object({
          domain: z.string(),
          label: z.string(),
          host: z.string(),
          status: z.string(),
          http_status: z.number().nullable(),
          response_time_ms: z.number().nullable(),
          tls_expires_at: z.string().nullable(),
          tls_days_remaining: z.number().nullable(),
        }),
      ),
      freshness: Freshness,
    }),
    handler: async (input) => {
      const env = envelope<WebsiteSnapshot[]>(snapshots, 'websites');
      let list = env.data;
      if (input.status !== 'all') list = list.filter((s) => s.status === input.status);
      return {
        total: list.length,
        sites: list.map((s) => ({
          domain: s.domain,
          label: s.label,
          host: s.host,
          status: s.status,
          http_status: s.httpStatus,
          response_time_ms: s.responseTimeMs,
          tls_expires_at: s.tls?.expiresAt ?? null,
          tls_days_remaining: s.tls?.daysRemaining ?? null,
        })),
        freshness: freshness(env),
      };
    },
  }));

  tools.push(defineTool({
    name: 'carbo_get_website_status',
    title: 'Single website status',
    description:
      'Returns reachability and certificate detail for one managed website, identified by its domain. ' +
      'Call carbo_list_managed_websites first for valid domains. ' +
      'It cannot check a domain outside the managed catalogue, cannot read page content, and cannot ' +
      'change DNS, hosting, or site content.',
    scope: 'carbo:websites:read',
    risk: 1,
    enabled: true,
    inputSchema: z.object({
      domain: z
        .string()
        .min(3)
        .max(253)
        .regex(/^[a-z0-9.-]+$/i, 'must be a hostname')
        .describe('Domain from carbo_list_managed_websites.'),
    }),
    outputSchema: z.object({
      domain: z.string(),
      label: z.string(),
      host: z.string(),
      status: z.string(),
      http_status: z.number().nullable(),
      response_time_ms: z.number().nullable(),
      tls: z
        .object({ valid: z.boolean(), expires_at: z.string().nullable(), days_remaining: z.number().nullable() })
        .nullable(),
      last_checked_at: z.string(),
      freshness: Freshness,
    }),
    handler: async (input) => {
      const env = envelope<WebsiteSnapshot[]>(snapshots, 'websites');
      const needle = input.domain.toLowerCase();
      const site = env.data.find((s) => s.domain.toLowerCase() === needle);
      if (!site) {
        throw new ToolError(
          'not_found',
          `"${input.domain}" is not in the managed website catalogue. Call carbo_list_managed_websites for valid domains.`,
        );
      }
      return {
        domain: site.domain,
        label: site.label,
        host: site.host,
        status: site.status,
        http_status: site.httpStatus,
        response_time_ms: site.responseTimeMs,
        tls: site.tls
          ? { valid: site.tls.valid, expires_at: site.tls.expiresAt, days_remaining: site.tls.daysRemaining }
          : null,
        last_checked_at: site.lastCheckedAt,
        freshness: freshness(env),
      };
    },
  }));

  // -------------------------------------------------------------------- n8n

  tools.push(defineTool({
    name: 'carbo_list_n8n_workflows',
    title: 'n8n workflows',
    description:
      'Lists the automation workflows defined in n8n with their name, whether they are active, node count ' +
      'and last-modified time. Use it for "what automations do I have" and "is workflow X enabled". ' +
      'It returns workflow metadata only — never node parameters, credentials, or the data that flowed ' +
      'through a run — and it cannot create, edit, activate, deactivate, or execute a workflow.',
    scope: 'carbo:n8n:read',
    risk: 1,
    enabled: true,
    inputSchema: z.object({
      active_only: z.boolean().default(false),
      name_contains: z.string().max(120).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    outputSchema: z.object({
      reachable: z.boolean(),
      total_workflows: z.number(),
      active_workflows: z.number(),
      returned: z.number(),
      workflows: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          active: z.boolean(),
          node_count: z.number().nullable(),
          updated_at: z.string().nullable(),
        }),
      ),
      freshness: Freshness,
    }),
    handler: async (input) => {
      const env = envelope<N8nSnapshot>(snapshots, 'n8n');
      let list = env.data.workflows;
      if (input.active_only) list = list.filter((w) => w.active);
      if (input.name_contains) {
        const needle = input.name_contains.toLowerCase();
        list = list.filter((w) => w.name.toLowerCase().includes(needle));
      }
      const page = list.slice(0, input.limit);
      return {
        reachable: env.data.reachable,
        total_workflows: env.data.counts.workflowsTotal,
        active_workflows: env.data.counts.workflowsActive,
        returned: page.length,
        workflows: page.map((w) => ({
          id: w.id,
          name: w.name,
          active: w.active,
          node_count: w.nodeCount,
          updated_at: w.updatedAt,
        })),
        freshness: freshness(env),
      };
    },
  }));

  tools.push(defineTool({
    name: 'carbo_get_n8n_execution_status',
    title: 'n8n execution history',
    description:
      'Returns recent n8n workflow executions with status (success, error, running, waiting), start time ' +
      'and duration, optionally filtered to one workflow id. Use it for "did last night\'s automation run" ' +
      'and "which workflows are failing". ' +
      'It returns execution metadata only — never the data an execution processed and never error stack ' +
      'traces — and it cannot re-run, retry, or delete an execution.',
    scope: 'carbo:n8n:read',
    risk: 1,
    enabled: true,
    inputSchema: z.object({
      workflow_id: identifier.optional().describe('Restrict to one workflow. Omit for all workflows.'),
      status: z.enum(['all', 'success', 'error', 'running', 'waiting']).default('all'),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    outputSchema: z.object({
      total_matched: z.number(),
      returned: z.number(),
      summary: z.object({ success: z.number(), error: z.number(), other: z.number() }),
      executions: z.array(
        z.object({
          id: z.string(),
          workflow_id: z.string(),
          workflow_name: z.string().nullable(),
          status: z.string(),
          started_at: z.string().nullable(),
          duration_ms: z.number().nullable(),
        }),
      ),
      freshness: Freshness,
    }),
    handler: async (input) => {
      const env = envelope<N8nSnapshot>(snapshots, 'n8n');
      let list = env.data.executions;
      if (input.workflow_id) list = list.filter((e) => e.workflowId === input.workflow_id);
      if (input.status !== 'all') list = list.filter((e) => e.status === input.status);

      const summary = {
        success: list.filter((e) => e.status === 'success').length,
        error: list.filter((e) => e.status === 'error').length,
        other: list.filter((e) => e.status !== 'success' && e.status !== 'error').length,
      };
      const page = list.slice(0, input.limit);
      return {
        total_matched: list.length,
        returned: page.length,
        summary,
        executions: page.map((e) => ({
          id: e.id,
          workflow_id: e.workflowId,
          workflow_name: e.workflowName,
          status: e.status,
          started_at: e.startedAt,
          duration_ms: e.durationMs,
        })),
        freshness: freshness(env),
      };
    },
  }));

  // ------------------------------------------------------------ video factory

  tools.push(defineTool({
    name: 'carbo_get_video_factory_status',
    title: 'Video Factory status',
    description:
      'Returns the state of the Video Factory v2 pipeline: when the overnight batch last ran and whether ' +
      'it succeeded, when the next run is scheduled, how many jobs are in each state, and how many rendered ' +
      'outputs exist. Use it for "did the video pipeline run last night". ' +
      'It cannot queue, start, cancel, or render a job, and returns no video files or media paths.',
    scope: 'carbo:video:read',
    risk: 1,
    enabled: true,
    inputSchema: z.object({}),
    outputSchema: z.object({
      pipeline: z.string(),
      last_batch_run_at: z.string().nullable(),
      last_batch_result: z.string(),
      next_scheduled_run_at: z.string().nullable(),
      job_counts: z.record(z.string(), z.number()),
      outputs: z.object({ count: z.number(), latest_at: z.string().nullable(), total_size_mb: z.number() }),
      freshness: Freshness,
    }),
    handler: async () => {
      const env = envelope<VideoSnapshot>(snapshots, 'video');
      const d = env.data;
      return {
        pipeline: d.pipelineName,
        last_batch_run_at: d.lastBatchRunAt,
        last_batch_result: d.lastBatchResult,
        next_scheduled_run_at: d.nextScheduledRunAt,
        job_counts: d.counts,
        outputs: {
          count: d.outputs.count,
          latest_at: d.outputs.latestAt,
          total_size_mb: d.outputs.totalSizeMb,
        },
        freshness: freshness(env),
      };
    },
  }));

  tools.push(defineTool({
    name: 'carbo_list_video_jobs',
    title: 'Video Factory jobs',
    description:
      'Lists recent Video Factory jobs with state, current stage, progress percentage and a one-line ' +
      'failure category for failed jobs. Optionally filter by state. Use it for "what is rendering right now" ' +
      'and "which video jobs failed". ' +
      'It cannot queue, cancel, retry, or download a job, and it never returns full error output.',
    scope: 'carbo:video:read',
    risk: 1,
    enabled: true,
    inputSchema: z.object({
      state: z
        .enum(['all', 'queued', 'started', 'progress', 'completed', 'failed', 'cancelled'])
        .default('all'),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    outputSchema: z.object({
      total_matched: z.number(),
      returned: z.number(),
      jobs: z.array(
        z.object({
          id: z.string(),
          name: z.string().nullable(),
          state: z.string(),
          stage: z.string().nullable(),
          progress_percent: z.number().nullable(),
          created_at: z.string().nullable(),
          updated_at: z.string().nullable(),
          error_summary: z.string().nullable(),
        }),
      ),
      freshness: Freshness,
    }),
    handler: async (input) => {
      const env = envelope<VideoSnapshot>(snapshots, 'video');
      let list = env.data.jobs;
      if (input.state !== 'all') list = list.filter((j) => j.state === input.state);
      const page = list.slice(0, input.limit);
      return {
        total_matched: list.length,
        returned: page.length,
        jobs: page.map((j) => ({
          id: j.id,
          name: j.name,
          state: j.state,
          stage: j.stage,
          progress_percent: j.progressPercent,
          created_at: j.createdAt,
          updated_at: j.updatedAt,
          error_summary: j.errorSummary ? redactString(j.errorSummary).slice(0, 200) : null,
        })),
        freshness: freshness(env),
      };
    },
  }));

  // -------------------------------------------------------------- backups

  tools.push(defineTool({
    name: 'carbo_get_backup_status',
    title: 'Backup status',
    description:
      'Reports on each configured backup job: its schedule, when it last produced an artifact, how old that ' +
      'artifact is, how many are retained, and whether the job is on time or overdue. ' +
      'Use it for "are my backups running" and "when was the last database backup". ' +
      'It reports on backup *metadata* only — it never reads, lists, downloads, or restores backup contents, ' +
      'and it cannot trigger a backup.',
    scope: 'carbo:backups:read',
    risk: 1,
    enabled: true,
    inputSchema: z.object({}),
    outputSchema: z.object({
      overall_status: z.enum(['ok', 'attention', 'unknown']),
      jobs: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          schedule: z.string(),
          last_run_at: z.string().nullable(),
          age_hours: z.number().nullable(),
          status: z.string(),
          artifact_count: z.number(),
          latest_artifact_size_kb: z.number().nullable(),
          retention_note: z.string().nullable(),
        }),
      ),
      freshness: Freshness,
    }),
    handler: async () => {
      const env = envelope<BackupSnapshot[]>(snapshots, 'backups');
      const attention = env.data.some((b) => b.status === 'stale' || b.status === 'missing');
      const anyUnknown = env.data.every((b) => b.status === 'unknown');
      return {
        overall_status: anyUnknown ? 'unknown' : attention ? 'attention' : 'ok',
        jobs: env.data.map((b) => ({
          id: b.id,
          name: b.name,
          schedule: b.schedule,
          last_run_at: b.lastRunAt,
          age_hours: b.ageHours,
          status: b.status,
          artifact_count: b.artifactCount,
          latest_artifact_size_kb: b.latestArtifactSizeKb,
          retention_note: b.retentionNote,
        })),
        freshness: freshness(env),
      };
    },
  }));

  // -------------------------------------------------------------- projects

  tools.push(defineTool({
    name: 'carbo_get_project_status',
    title: 'Project repository status',
    description:
      'Returns the state of the tracked project repositories on carbo-server: current branch, whether the ' +
      'working tree has uncommitted changes and how many files, the last commit subject and date, and how ' +
      'far ahead or behind the upstream branch it is. Use it for "what was I last working on" and ' +
      '"do I have uncommitted work anywhere". ' +
      'It returns no file contents, no diffs, and no commit bodies, and it cannot commit, push, pull, ' +
      'branch, or check anything out.',
    scope: 'carbo:projects:read',
    risk: 1,
    enabled: true,
    inputSchema: z.object({
      project_id: identifier.optional().describe('Restrict to one project. Omit for all tracked projects.'),
      dirty_only: z.boolean().default(false),
    }),
    outputSchema: z.object({
      total: z.number(),
      projects: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          branch: z.string().nullable(),
          dirty: z.boolean(),
          changed_file_count: z.number(),
          last_commit: z
            .object({ short_sha: z.string(), subject: z.string(), authored_at: z.string() })
            .nullable(),
          ahead: z.number().nullable(),
          behind: z.number().nullable(),
          status: z.string(),
        }),
      ),
      freshness: Freshness,
    }),
    handler: async (input) => {
      const env = envelope<ProjectSnapshot[]>(snapshots, 'projects');
      let list = env.data;
      if (input.project_id) {
        list = list.filter((p) => p.id === input.project_id);
        if (list.length === 0) {
          throw new ToolError(
            'not_found',
            `No tracked project with id "${input.project_id}". Omit project_id to see all tracked projects.`,
          );
        }
      }
      if (input.dirty_only) list = list.filter((p) => p.dirty);
      return {
        total: list.length,
        projects: list.map((p) => ({
          id: p.id,
          name: p.name,
          branch: p.branch,
          dirty: p.dirty,
          changed_file_count: p.changedFileCount,
          last_commit: p.lastCommit
            ? {
                short_sha: p.lastCommit.shortSha,
                subject: redactString(p.lastCommit.subject).slice(0, 160),
                authored_at: p.lastCommit.authoredAt,
              }
            : null,
          ahead: p.aheadBehind?.ahead ?? null,
          behind: p.aheadBehind?.behind ?? null,
          status: p.status,
        })),
        freshness: freshness(env),
      };
    },
  }));

  // ---------------------------------------------------------------- errors

  tools.push(defineTool({
    name: 'carbo_get_recent_error_summary',
    title: 'Recent error summary',
    description:
      'Returns a bounded, sanitized summary of recent errors and warnings across monitored log sources, ' +
      'grouped into deduplicated patterns with occurrence counts and last-seen times, plus the result of ' +
      'the nightly security scan. Use it for "is anything broken" and "what has been erroring overnight". ' +
      'It returns *patterns and counts only* — never raw log lines, stack traces, request bodies, ' +
      'credentials, IP addresses of users, or personal data — and the window is capped at 7 days.',
    scope: 'carbo:server:read',
    risk: 1,
    enabled: true,
    inputSchema: z.object({
      window_hours: z
        .number()
        .int()
        .min(1)
        .max(168)
        .default(24)
        .describe('Look-back window in hours. Capped at 168 (7 days).'),
      source: identifier.optional().describe('Restrict to one log source. Omit for all sources.'),
      max_patterns: z.number().int().min(1).max(25).default(10),
    }),
    outputSchema: z.object({
      window_hours: z.number(),
      total_errors: z.number(),
      total_warnings: z.number(),
      sources: z.array(
        z.object({
          source: z.string(),
          error_count: z.number(),
          warning_count: z.number(),
          top_patterns: z.array(
            z.object({ pattern: z.string(), count: z.number(), last_seen_at: z.string().nullable() }),
          ),
        }),
      ),
      security_scan: z
        .object({
          last_run_at: z.string().nullable(),
          findings_count: z.number(),
          severity_summary: z.string().nullable(),
        })
        .nullable(),
      freshness: Freshness,
    }),
    handler: async (input) => {
      const env = envelope<ErrorSummarySnapshot>(snapshots, 'errors');
      let sources = env.data.sources.filter((s) => s.windowHours <= input.window_hours || true);
      if (input.source) {
        sources = sources.filter((s) => s.source === input.source);
        if (sources.length === 0) {
          throw new ToolError(
            'not_found',
            `No log source named "${input.source}". Omit source to see all monitored sources.`,
          );
        }
      }
      return {
        window_hours: input.window_hours,
        total_errors: sources.reduce((n, s) => n + s.errorCount, 0),
        total_warnings: sources.reduce((n, s) => n + s.warningCount, 0),
        sources: sources.map((s) => ({
          source: s.source,
          error_count: s.errorCount,
          warning_count: s.warningCount,
          top_patterns: s.topPatterns.slice(0, input.max_patterns).map((p) => ({
            pattern: redactString(p.pattern).slice(0, 200),
            count: p.count,
            last_seen_at: p.lastSeenAt,
          })),
        })),
        security_scan: env.data.securityScan
          ? {
              last_run_at: env.data.securityScan.lastRunAt,
              findings_count: env.data.securityScan.findingsCount,
              severity_summary: env.data.securityScan.severitySummary,
            }
          : null,
        freshness: freshness(env),
      };
    },
  }));

  // ---------------------------------------------------------- carbo design

  tools.push(defineTool({
    name: 'carbo_get_design_status',
    title: 'Carbo Design overview',
    description:
      'Returns an overview of the Carbo Design component system: how many projects, components, sites ' +
      'and publications exist, how many components are published versus draft, and whether the service ' +
      'is reachable. Use it for "what is in Carbo Design" and as the first step before the more specific ' +
      'design tools. ' +
      'Carbo Design is the visual component studio at /opt/carbo-design — it is a different system from ' +
      'this gateway. This tool reads it through a token holding only read scopes, so it cannot create, ' +
      'edit, publish, or unpublish anything, and it returns no component HTML, CSS, or JavaScript.',
    scope: 'carbo:design:read',
    risk: 1,
    enabled: true,
    inputSchema: z.object({}),
    outputSchema: z.object({
      reachable: z.boolean(),
      counts: z.object({
        projects: z.number(),
        components: z.number(),
        components_published: z.number(),
        components_draft: z.number(),
        sites: z.number(),
        publications: z.number(),
      }),
      sites: z.array(
        z.object({
          slug: z.string(),
          name: z.string(),
          environment: z.string(),
          is_active: z.boolean(),
          published_count: z.number(),
        }),
      ),
      projects: z.array(
        z.object({ slug: z.string(), name: z.string(), component_count: z.number(), updated_at: z.string().nullable() }),
      ),
      freshness: Freshness,
    }),
    handler: async () => {
      const env = envelope<DesignSnapshot>(snapshots, 'design');
      const d = env.data;
      if (!d.reachable) {
        throw new ToolError(
          'unavailable',
          'Carbo Design is not reachable, or the gateway has no read token for it. Check that carbo-design-api is running.',
        );
      }
      return {
        reachable: d.reachable,
        counts: {
          projects: d.counts.projects,
          components: d.counts.components,
          components_published: d.counts.componentsPublished,
          components_draft: d.counts.componentsDraft,
          sites: d.counts.sites,
          publications: d.counts.publications,
        },
        sites: d.sites.map((x) => ({
          slug: x.slug,
          name: x.name,
          environment: x.environment,
          is_active: x.isActive,
          published_count: x.publishedCount,
        })),
        projects: d.projects.map((x) => ({
          slug: x.slug,
          name: x.name,
          component_count: x.componentCount,
          updated_at: x.updatedAt,
        })),
        freshness: freshness(env),
      };
    },
  }));

  tools.push(defineTool({
    name: 'carbo_list_design_components',
    title: 'Carbo Design components',
    description:
      'Lists components in Carbo Design with their kind, publication status, latest version number, ' +
      'owning project and last-modified time. Filter by project slug, by status, or by a name substring. ' +
      'Use it for "what components do I have", "what is still a draft", and "which components changed recently". ' +
      'It returns metadata only — never the component HTML, CSS, JavaScript, or rendered output — and ' +
      'it cannot create, edit, duplicate, delete, or publish a component.',
    scope: 'carbo:design:read',
    risk: 1,
    enabled: true,
    inputSchema: z.object({
      project_slug: identifier.optional().describe('Restrict to one project. Omit for all projects.'),
      status: z.enum(['all', 'published', 'draft']).default('all'),
      name_contains: z.string().max(120).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    outputSchema: z.object({
      total_matched: z.number(),
      returned: z.number(),
      components: z.array(
        z.object({
          slug: z.string(),
          name: z.string(),
          kind: z.string(),
          status: z.string(),
          project_slug: z.string().nullable(),
          latest_version: z.number().nullable(),
          updated_at: z.string().nullable(),
        }),
      ),
      freshness: Freshness,
    }),
    handler: async (input) => {
      const env = envelope<DesignSnapshot>(snapshots, 'design');
      let list = env.data.components;
      if (input.project_slug) list = list.filter((c) => c.projectSlug === input.project_slug);
      if (input.status === 'published') list = list.filter((c) => c.status === 'published');
      else if (input.status === 'draft') list = list.filter((c) => c.status !== 'published');
      if (input.name_contains) {
        const needle = input.name_contains.toLowerCase();
        list = list.filter(
          (c) => c.name.toLowerCase().includes(needle) || c.slug.toLowerCase().includes(needle),
        );
      }
      const page = list.slice(0, input.limit);
      return {
        total_matched: list.length,
        returned: page.length,
        components: page.map((c) => ({
          slug: c.slug,
          name: c.name,
          kind: c.kind,
          status: c.status,
          project_slug: c.projectSlug,
          latest_version: c.latestVersion,
          updated_at: c.updatedAt,
        })),
        freshness: freshness(env),
      };
    },
  }));

  tools.push(defineTool({
    name: 'carbo_get_design_publications',
    title: 'Carbo Design publications',
    description:
      'Shows which Carbo Design components are currently published to which sites, and at which version. ' +
      'Optionally filter to one site by slug. Use it to answer "what is actually live on the site right now" ' +
      'and "which version is that page serving". ' +
      'It reports the publication record only — it cannot publish, unpublish, roll back, or change a ' +
      'pinned version, and it returns no page or component content. Publishing in Carbo Design ' +
      'deliberately requires a human approval step that this gateway has no ability to satisfy.',
    scope: 'carbo:design:read',
    risk: 1,
    enabled: true,
    inputSchema: z.object({
      site_slug: identifier.optional().describe('Restrict to one site. Omit for all sites.'),
    }),
    outputSchema: z.object({
      total: z.number(),
      publications: z.array(
        z.object({
          site_slug: z.string(),
          component_slug: z.string(),
          component_name: z.string().nullable(),
          version: z.number().nullable(),
          published_at: z.string().nullable(),
        }),
      ),
      freshness: Freshness,
    }),
    handler: async (input) => {
      const env = envelope<DesignSnapshot>(snapshots, 'design');
      let list = env.data.publications;
      if (input.site_slug) {
        const known = new Set(env.data.sites.map((s) => s.slug));
        if (!known.has(input.site_slug)) {
          throw new ToolError(
            'not_found',
            `No Carbo Design site with slug "${input.site_slug}". Call carbo_get_design_status for valid slugs.`,
          );
        }
        list = list.filter((p) => p.siteSlug === input.site_slug);
      }
      return {
        total: list.length,
        publications: list.map((p) => ({
          site_slug: p.siteSlug,
          component_slug: p.componentSlug,
          component_name: p.componentName,
          version: p.version,
          published_at: p.publishedAt,
        })),
        freshness: freshness(env),
      };
    },
  }));

  tools.push(defineTool({
    name: 'carbo_get_design_activity',
    title: 'Carbo Design recent activity',
    description:
      'Summarizes what has happened in Carbo Design over the last 24 hours: how many audited actions ' +
      'occurred, the most frequent action types, how many failed, and when the most recent event was. ' +
      'Use it for "has anyone been editing components" and "did anything fail in the design system". ' +
      'It returns aggregate counts only — never actor identities, IP addresses, request bodies, or the ' +
      'content of what changed.',
    scope: 'carbo:design:read',
    risk: 1,
    enabled: true,
    inputSchema: z.object({
      max_actions: z.number().int().min(1).max(15).default(10),
    }),
    outputSchema: z.object({
      window_hours: z.number(),
      total_events: z.number(),
      failures: z.number(),
      last_event_at: z.string().nullable(),
      top_actions: z.array(z.object({ action: z.string(), count: z.number() })),
      freshness: Freshness,
    }),
    handler: async (input) => {
      const env = envelope<DesignSnapshot>(snapshots, 'design');
      const a = env.data.activity;
      return {
        window_hours: a.windowHours,
        total_events: a.total,
        failures: a.failures,
        last_event_at: a.lastEventAt,
        top_actions: a.byAction.slice(0, input.max_actions),
        freshness: freshness(env),
      };
    },
  }));

  // ------------------------------------------------------------- monitoring

  tools.push(defineTool({
    name: 'carbo_get_monitoring_summary',
    title: 'Uptime Kuma summary',
    description:
      'Returns the overall state of the Uptime Kuma monitoring stack: how many monitors are up, down or ' +
      'in another state, which ones are currently down, and any TLS certificate expiring soon. ' +
      'This is an independent second opinion on availability — Uptime Kuma probes from the AWS EC2 box, ' +
      'outside this server, so it sees outages that carbo-server\'s own probes cannot. ' +
      'It cannot create, pause, resume, or delete a monitor, and it cannot acknowledge an incident.',
    scope: 'carbo:monitoring:read',
    risk: 1,
    enabled: true,
    inputSchema: z.object({
      cert_warning_days: z.number().int().min(1).max(365).default(30),
    }),
    outputSchema: z.object({
      configured: z.boolean(),
      reachable: z.boolean(),
      note: z.string().nullable(),
      counts: z.object({ total: z.number(), up: z.number(), down: z.number(), other: z.number() }),
      down: z.array(z.object({ name: z.string(), status: z.string() })),
      certificates_expiring_soon: z.array(z.object({ name: z.string(), days_remaining: z.number() })),
      freshness: Freshness,
    }),
    handler: async (input) => {
      const env = envelope<MonitoringSnapshot>(snapshots, 'monitoring');
      const d = env.data;
      if (!d.configured) {
        throw new ToolError(
          'unavailable',
          d.note ?? 'Uptime Kuma is not configured for this gateway yet.',
        );
      }
      return {
        configured: d.configured,
        reachable: d.reachable,
        note: d.note,
        counts: d.counts,
        down: d.monitors.filter((m) => m.status === 'down').map((m) => ({ name: m.name, status: m.status })),
        certificates_expiring_soon: d.monitors
          .filter((m) => m.certDaysRemaining !== null && m.certDaysRemaining <= input.cert_warning_days)
          .map((m) => ({ name: m.name, days_remaining: m.certDaysRemaining as number }))
          .sort((a, b) => a.days_remaining - b.days_remaining),
        freshness: freshness(env),
      };
    },
  }));

  tools.push(defineTool({
    name: 'carbo_list_monitors',
    title: 'Uptime Kuma monitors',
    description:
      'Lists the individual Uptime Kuma monitors with their current status, last response time and TLS ' +
      'certificate days remaining, filterable by status or a name substring. Use it for "is X up according ' +
      'to monitoring" and "which monitors are slow". ' +
      'It returns current state only — no historical uptime series and no incident history — and it ' +
      'cannot change, pause, or delete a monitor.',
    scope: 'carbo:monitoring:read',
    risk: 1,
    enabled: true,
    inputSchema: z.object({
      status: z.enum(['all', 'up', 'down', 'pending', 'maintenance']).default('all'),
      name_contains: z.string().max(120).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    outputSchema: z.object({
      configured: z.boolean(),
      total_matched: z.number(),
      returned: z.number(),
      monitors: z.array(
        z.object({
          name: z.string(),
          status: z.string(),
          response_time_ms: z.number().nullable(),
          cert_days_remaining: z.number().nullable(),
        }),
      ),
      freshness: Freshness,
    }),
    handler: async (input) => {
      const env = envelope<MonitoringSnapshot>(snapshots, 'monitoring');
      const d = env.data;
      if (!d.configured) {
        throw new ToolError('unavailable', d.note ?? 'Uptime Kuma is not configured for this gateway yet.');
      }
      let list = d.monitors;
      if (input.status !== 'all') list = list.filter((m) => m.status === input.status);
      if (input.name_contains) {
        const needle = input.name_contains.toLowerCase();
        list = list.filter((m) => m.name.toLowerCase().includes(needle));
      }
      const page = list.slice(0, input.limit);
      return {
        configured: d.configured,
        total_matched: list.length,
        returned: page.length,
        monitors: page.map((m) => ({
          name: m.name,
          status: m.status,
          response_time_ms: m.responseTimeMs,
          cert_days_remaining: m.certDaysRemaining,
        })),
        freshness: freshness(env),
      };
    },
  }));

  // ----------------------------------------------------------------- audit

  tools.push(defineTool({
    name: 'carbo_get_mcp_audit_summary',
    title: 'MCP gateway audit summary',
    description:
      'Summarizes this gateway\'s own audit trail: how many clients connected, how many tool listings and ' +
      'tool calls were made, how many succeeded, were denied, errored or were rate-limited in the requested ' +
      'window, which tools were used most, and how many authentication failures occurred. Use it to review ' +
      'who has been using the connector and whether anything is being refused. ' +
      'It returns aggregate counts only — never tokens, never argument values, never tool responses.',
    scope: 'carbo:audit:read',
    risk: 1,
    enabled: true,
    inputSchema: z.object({
      window_hours: z.number().int().min(1).max(168).default(24),
      max_events: z.number().int().min(50).max(2000).default(500),
    }),
    outputSchema: z.object({
      window_hours: z.number(),
      events_examined: z.number(),
      totals: z.object({
        tool_calls: z.number(),
        connections: z.number(),
        tool_listings: z.number(),
        success: z.number(),
        denied: z.number(),
        error: z.number(),
        timeout: z.number(),
        rate_limited: z.number(),
        auth_failures: z.number(),
      }),
      top_tools: z.array(z.object({ tool: z.string(), calls: z.number() })),
      distinct_subjects: z.number(),
      error_categories: z.array(z.object({ category: z.string(), count: z.number() })),
    }),
    handler: async (input) => {
      const cutoff = Date.now() - input.window_hours * 3600_000;
      const events = audit
        .readRecent(input.max_events)
        .filter((e) => Date.parse(e.timestamp) >= cutoff);

      const toolCounts = new Map<string, number>();
      const errorCounts = new Map<string, number>();
      const subjects = new Set<string>();
      const totals = {
        tool_calls: 0,
        connections: 0,
        tool_listings: 0,
        success: 0,
        denied: 0,
        error: 0,
        timeout: 0,
        rate_limited: 0,
        auth_failures: 0,
      };

      for (const e of events) {
        if (e.subject && e.subject !== 'anonymous') subjects.add(e.subject);
        if (e.event === 'auth_failure') totals.auth_failures++;
        if (e.event === 'initialize') totals.connections++;
        if (e.event === 'tools_list') totals.tool_listings++;
        if (e.event === 'tool_call') {
          totals.tool_calls++;
          if (e.toolName) toolCounts.set(e.toolName, (toolCounts.get(e.toolName) ?? 0) + 1);
        }
        if (e.outcome === 'success') totals.success++;
        else if (e.outcome === 'denied') totals.denied++;
        else if (e.outcome === 'error') totals.error++;
        else if (e.outcome === 'timeout') totals.timeout++;
        else if (e.outcome === 'rate_limited') totals.rate_limited++;
        if (e.errorCategory) errorCounts.set(e.errorCategory, (errorCounts.get(e.errorCategory) ?? 0) + 1);
      }

      const top = [...toolCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([tool, calls]) => ({ tool, calls }));
      const errs = [...errorCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([category, count]) => ({ category, count }));

      return {
        window_hours: input.window_hours,
        events_examined: events.length,
        totals,
        top_tools: top,
        distinct_subjects: subjects.size,
        error_categories: errs,
      };
    },
  }));

  return tools;
}

/**
 * Capabilities that are designed but deliberately not implemented. Kept in
 * code so the boundary is reviewable alongside the enabled set; none of these
 * has a handler, so none can be invoked.
 */
export const DEFERRED_TOOLS: DeferredTool[] = [
  {
    name: 'carbo_create_wordpress_draft',
    title: 'Create a WordPress draft post',
    description: 'Create an unpublished draft on one managed WordPress site.',
    scope: 'carbo:websites:write',
    risk: 2,
    reason:
      'Level 2. Safe in principle (drafts are reversible and never public) but needs a per-site ' +
      'application password scoped to draft creation, plus a title/body length cap and a rate cap.',
    prerequisites: [
      'Per-site WordPress application password with author-only capability',
      'Draft-only enforcement verified against the REST API (status must be forced to "draft")',
      'Content length limits and an approval record in the audit log',
    ],
  },
  {
    name: 'carbo_queue_video_job',
    title: 'Queue a Video Factory render job',
    description: 'Add a render job to the Video Factory v2 queue from an approved source asset.',
    scope: 'carbo:video:write',
    risk: 2,
    reason:
      'Level 2. Reversible (jobs can be cancelled and produce files, not publications) but consumes ' +
      'significant CPU and disk, so it needs a concurrency cap and a source-asset allowlist first.',
    prerequisites: [
      'Source asset allowlist so an arbitrary path cannot be rendered',
      'Queue depth and per-day job caps',
      'A matching cancel path so a queued job is reversible',
    ],
  },
  {
    name: 'carbo_generate_infrastructure_report',
    title: 'Generate an infrastructure report',
    description: 'Produce a dated infrastructure report file from existing snapshots.',
    scope: 'carbo:server:write',
    risk: 2,
    reason:
      'Level 2. Writes only to a dedicated report directory and is trivially reversible, but is ' +
      'deferred until the Level 1 set has been in use long enough to show which report shape is wanted.',
    prerequisites: ['Dedicated write-only report volume', 'Output size cap and retention policy'],
  },
  {
    name: 'carbo_publish_wordpress_post',
    title: 'Publish a WordPress post',
    description: 'Move a draft to published on a managed site.',
    scope: 'carbo:websites:publish',
    risk: 3,
    reason:
      'Level 3 — externally visible and not silently reversible. Not planned for gateway exposure; ' +
      'publishing should stay a deliberate human action in the WordPress admin.',
    prerequisites: ['Explicit per-call human confirmation outside the MCP channel'],
  },
  {
    name: 'carbo_send_notification',
    title: 'Send a Discord or email notification',
    description: 'Send a message through the existing Discord bot or Brevo relay.',
    scope: 'carbo:messaging:send',
    risk: 3,
    reason:
      'Level 3 — reaches third parties and cannot be recalled. Existing automation already covers the ' +
      'scheduled cases; ad-hoc sending from a chat client is not a capability worth the abuse surface.',
    prerequisites: ['Recipient allowlist', 'Per-day send cap', 'Out-of-band confirmation'],
  },
  {
    name: 'carbo_restart_service',
    title: 'Restart a container or service',
    description: 'Restart one named container.',
    scope: 'carbo:docker:admin',
    risk: 4,
    reason:
      'Level 4 — administrative and disruptive. Explicitly excluded: it would require Docker socket ' +
      'access, which this architecture is built to avoid entirely.',
    prerequisites: ['Not planned. Use SSH or the existing operations scripts instead.'],
  },
  {
    name: 'carbo_run_command',
    title: 'Run a shell command',
    description: 'Execute an arbitrary command on the host.',
    scope: 'carbo:host:exec',
    risk: 4,
    reason:
      'Level 4 — permanently excluded by design. No arbitrary command execution, shell, terminal, or ' +
      'file browser will be exposed through this gateway under any configuration.',
    prerequisites: ['Never. This is a hard architectural exclusion.'],
  },
];
