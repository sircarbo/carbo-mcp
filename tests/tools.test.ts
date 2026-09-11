/**
 * Tool behaviour against fixture snapshots: correct summarization, correct
 * filtering, bounded output, sanitized output, and honest freshness reporting.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotReader } from '../src/adapters/snapshots.js';
import { AuditLog } from '../src/logging/audit.js';
import { createLogger } from '../src/logging/logger.js';
import { ToolRegistry, ToolError } from '../src/tools/registry.js';
import { buildTools, DEFERRED_TOOLS } from '../src/tools/definitions.js';
import { writeFixtureSnapshots } from './helpers.js';

const logger = createLogger('silent');
let registry: ToolRegistry;
let audit: AuditLog;

function call(name: string, input: unknown = {}) {
  const tool = registry.get(name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  const parsed = tool.inputSchema.parse(input);
  return tool.handler(parsed, {
    requestId: 'test',
    subject: 'test-subject',
    signal: new AbortController().signal,
  });
}

beforeAll(() => {
  const snapshotDir = writeFixtureSnapshots();
  const auditDir = mkdtempSync(join(tmpdir(), 'carbo-mcp-audit-'));
  audit = new AuditLog(auditDir, 1024 * 1024, 3, logger);
  audit.init();
  registry = new ToolRegistry();
  for (const tool of buildTools({ snapshots: new SnapshotReader(snapshotDir, 300), audit })) {
    registry.register(tool);
  }
});

describe('registry', () => {
  it('registers exactly the twenty-two Level 1 tools', () => {
    expect(registry.names()).toHaveLength(22);
    expect(registry.names().every((n) => n.startsWith('carbo_'))).toBe(true);
  });

  it('marks every enabled tool as risk level 1 and read-only scoped', () => {
    for (const tool of registry.enabled()) {
      expect(tool.risk).toBe(1);
      expect(tool.scope).toMatch(/:read$/);
    }
  });

  it('refuses to enable a tool above risk level 1', () => {
    const rogue = registry.enabled()[0]!;
    expect(() =>
      registry.register({ ...rogue, name: 'carbo_dangerous', risk: 4, enabled: true }),
    ).toThrow(/only level 1 tools may be enabled/);
  });

  it('refuses duplicate registration', () => {
    const existing = registry.enabled()[0]!;
    expect(() => registry.register(existing)).toThrow(/duplicate/);
  });

  it('keeps every deferred capability unreachable', () => {
    for (const deferred of DEFERRED_TOOLS) {
      expect(registry.get(deferred.name)).toBeUndefined();
      expect(deferred).not.toHaveProperty('handler');
    }
    expect(DEFERRED_TOOLS.some((t) => t.name === 'carbo_run_command' && t.risk === 4)).toBe(true);
  });
});

describe('carbo_get_terminal_status', () => {
  it('reports the doors, recommends the Tailscale one, and flags the down door', async () => {
    const out = (await call('carbo_get_terminal_status')) as Record<string, any>;
    expect(out.overall_status).toBe('up');
    expect(out.recommended_url).toBe('https://carbo-server.tailca00c8.ts.net:8443/');
    expect(out.doors).toHaveLength(3);
    expect(out.tailscale_serve_active).toBe(true);
    expect(out.watchdog.timer_active).toBe(true);
    expect(out.concerns).toEqual(['Door "apache-name" is down']);
    // Facts only: nothing resembling a session, command or credential.
    expect(JSON.stringify(out)).not.toMatch(/password=|token|Bearer/);
  });
});

describe('carbo_get_server_health', () => {
  it('summarizes containers and services into one verdict', async () => {
    const out = (await call('carbo_get_server_health')) as Record<string, any>;
    expect(out.hostname).toBe('carbo-server');
    expect(out.containers).toEqual({ running: 2, unhealthy: 1, stopped: 1 });
    expect(out.services).toEqual({ up: 1, down: 1, unknown: 0 });
    // One unhealthy container and one down service must not read as healthy.
    expect(out.overall_status).toBe('unhealthy');
    expect(out.concerns.join(' ')).toMatch(/unhealthy|down/);
    expect(out.freshness.fresh).toBe(true);
  });
});

describe('carbo_get_system_resources', () => {
  it('returns the numbers without inventing any', async () => {
    const out = (await call('carbo_get_system_resources')) as Record<string, any>;
    expect(out.memory_mb.used_percent).toBe(45.7);
    expect(out.disks[0].mount).toBe('/');
    expect(out.cpu.cores).toBe(4);
  });
});

describe('carbo_list_container_status', () => {
  it('filters to unhealthy containers only', async () => {
    const out = (await call('carbo_list_container_status', { only: 'unhealthy' })) as Record<string, any>;
    expect(out.total_matched).toBe(1);
    expect(out.containers[0].name).toBe('broken-service');
    expect(out.containers[0].restart_count).toBe(7);
  });

  it('filters to stopped containers only', async () => {
    const out = (await call('carbo_list_container_status', { only: 'stopped' })) as Record<string, any>;
    expect(out.containers.map((c: any) => c.name)).toEqual(['stopped-service']);
  });

  it('honours the limit and reports the true match count', async () => {
    const out = (await call('carbo_list_container_status', { limit: 1 })) as Record<string, any>;
    expect(out.total_matched).toBe(3);
    expect(out.returned).toBe(1);
  });

  it('rejects a limit outside the allowed range', () => {
    const tool = registry.get('carbo_list_container_status')!;
    expect(() => tool.inputSchema.parse({ limit: 5000 })).toThrow();
    expect(() => tool.inputSchema.parse({ only: 'delete' })).toThrow();
  });

  it('rejects a name filter containing shell metacharacters', () => {
    const tool = registry.get('carbo_list_container_status')!;
    expect(() => tool.inputSchema.parse({ name_contains: 'n8n; rm -rf /' })).toThrow();
    expect(() => tool.inputSchema.parse({ name_contains: '$(whoami)' })).toThrow();
  });

  it('rejects an over-long identifier', () => {
    const tool = registry.get('carbo_get_service_health')!;
    expect(() => tool.inputSchema.parse({ service_id: 'a'.repeat(500) })).toThrow();
  });
});

describe('carbo_get_service_health', () => {
  it('joins the service to its container', async () => {
    const out = (await call('carbo_get_service_health', { service_id: 'n8n' })) as Record<string, any>;
    expect(out.status).toBe('up');
    expect(out.container).toEqual({ name: 'n8n', state: 'running', health: 'none', restart_count: 0 });
  });

  it('gives an actionable not-found rather than an empty result', async () => {
    await expect(call('carbo_get_service_health', { service_id: 'vaultwarden' })).rejects.toThrow(
      /No monitored service/,
    );
  });
});

describe('carbo_list_services', () => {
  it('filters by status', async () => {
    const out = (await call('carbo_list_services', { status: 'down' })) as Record<string, any>;
    expect(out.total).toBe(1);
    expect(out.services[0].id).toBe('wordpress-local');
  });

  it('never surfaces the excluded services', async () => {
    const out = (await call('carbo_list_services')) as Record<string, any>;
    const ids = out.services.map((s: any) => s.id).join(' ');
    expect(ids).not.toMatch(/vaultwarden|postgres|mariadb|-db/);
  });
});

describe('n8n tools', () => {
  it('lists workflows and filters to active ones', async () => {
    const all = (await call('carbo_list_n8n_workflows')) as Record<string, any>;
    expect(all.total_workflows).toBe(2);
    const active = (await call('carbo_list_n8n_workflows', { active_only: true })) as Record<string, any>;
    expect(active.workflows).toHaveLength(1);
    expect(active.workflows[0].name).toBe('HBB - Weekly SEO Report');
  });

  it('summarizes execution outcomes and filters by status', async () => {
    const out = (await call('carbo_get_n8n_execution_status')) as Record<string, any>;
    expect(out.summary).toEqual({ success: 1, error: 1, other: 0 });
    const errors = (await call('carbo_get_n8n_execution_status', { status: 'error' })) as Record<string, any>;
    expect(errors.executions).toHaveLength(1);
    expect(errors.executions[0].id).toBe('452');
  });

  it('returns no workflow node contents', async () => {
    const out = JSON.stringify(await call('carbo_list_n8n_workflows'));
    expect(out).not.toMatch(/parameters|credentials|nodes":\[/);
  });
});

describe('video factory tools', () => {
  it('reports the batch schedule and result', async () => {
    const out = (await call('carbo_get_video_factory_status')) as Record<string, any>;
    expect(out.last_batch_result).toBe('success');
    expect(out.outputs.count).toBe(8);
  });

  it('sanitizes a job error summary', async () => {
    const out = (await call('carbo_list_video_jobs', { state: 'failed' })) as Record<string, any>;
    expect(out.jobs).toHaveLength(1);
    // The fixture's error line carries a token-shaped string; it must not survive.
    expect(out.jobs[0].error_summary).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(out.jobs[0].error_summary).toContain('[redacted]');
    expect(out.jobs[0].error_summary.length).toBeLessThanOrEqual(200);
  });
});

describe('carbo_get_backup_status', () => {
  it('flags a stale job in the overall verdict', async () => {
    const out = (await call('carbo_get_backup_status')) as Record<string, any>;
    expect(out.overall_status).toBe('attention');
    expect(out.jobs.find((j: any) => j.id === 'stale-job').status).toBe('stale');
  });

  it('returns no backup contents or filesystem paths', async () => {
    const out = JSON.stringify(await call('carbo_get_backup_status'));
    expect(out).not.toMatch(/\/opt\/|\/home\/|sql|gz"/);
  });
});

describe('carbo_get_project_status', () => {
  it('filters to dirty repositories', async () => {
    const out = (await call('carbo_get_project_status', { dirty_only: true })) as Record<string, any>;
    expect(out.projects).toHaveLength(1);
    expect(out.projects[0].id).toBe('carbo-design');
  });

  it('never returns the repository path', async () => {
    const out = JSON.stringify(await call('carbo_get_project_status'));
    expect(out).not.toContain('/opt/carbo-design');
  });

  it('reports an unknown project id as not found', async () => {
    await expect(call('carbo_get_project_status', { project_id: 'nope' })).rejects.toBeInstanceOf(ToolError);
  });
});

describe('carbo_get_recent_error_summary', () => {
  it('returns patterns and counts, never raw lines', async () => {
    const out = (await call('carbo_get_recent_error_summary')) as Record<string, any>;
    expect(out.total_errors).toBe(3);
    expect(out.sources[0].top_patterns[0].count).toBe(3);
    expect(out.security_scan.findings_count).toBe(3);
  });

  it('caps the window at seven days', () => {
    const tool = registry.get('carbo_get_recent_error_summary')!;
    expect(() => tool.inputSchema.parse({ window_hours: 10000 })).toThrow();
    expect(tool.inputSchema.parse({ window_hours: 168 }).window_hours).toBe(168);
  });

  it('caps the number of patterns returned', async () => {
    const out = (await call('carbo_get_recent_error_summary', { max_patterns: 1 })) as Record<string, any>;
    expect(out.sources[0].top_patterns.length).toBeLessThanOrEqual(1);
  });
});

describe('carbo_get_mcp_audit_summary', () => {
  it('aggregates recorded events without exposing their parameters', async () => {
    audit.write({ requestId: 'r1', subject: 'sub-a', event: 'tool_call', toolName: 'carbo_get_server_health', outcome: 'success', rawParams: { secret_value: 'nope' } });
    audit.write({ requestId: 'r2', subject: 'anonymous', event: 'auth_failure', outcome: 'denied', errorCategory: 'expired_token' });
    await new Promise((r) => setTimeout(r, 60));

    const out = (await call('carbo_get_mcp_audit_summary')) as Record<string, any>;
    expect(out.totals.tool_calls).toBeGreaterThanOrEqual(1);
    expect(out.totals.auth_failures).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(out)).not.toContain('nope');
  });
});

describe('staleness reporting', () => {
  it('marks data stale instead of presenting it as current', async () => {
    const oldDir = writeFixtureSnapshots(new Date(Date.now() - 3600_000).toISOString());
    const stale = new ToolRegistry();
    for (const tool of buildTools({ snapshots: new SnapshotReader(oldDir, 300), audit })) {
      stale.register(tool);
    }
    const tool = stale.get('carbo_get_server_health')!;
    const out = (await tool.handler({}, { requestId: 't', subject: 's', signal: new AbortController().signal })) as Record<string, any>;
    expect(out.freshness.fresh).toBe(false);
    expect(out.freshness.age_seconds).toBeGreaterThan(300);
    expect(out.overall_status).toBe('unknown');
  });

  it('reports a missing snapshot as unavailable rather than guessing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'carbo-mcp-empty-'));
    const bare = new ToolRegistry();
    for (const tool of buildTools({ snapshots: new SnapshotReader(empty, 300), audit })) {
      bare.register(tool);
    }
    const tool = bare.get('carbo_get_system_resources')!;
    await expect(
      tool.handler({}, { requestId: 't', subject: 's', signal: new AbortController().signal }),
    ).rejects.toThrow(/not available|has not been produced/);
  });
});
