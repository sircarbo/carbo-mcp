/**
 * The Carbo Design and Uptime Kuma tools.
 *
 * Two properties matter most here and are asserted explicitly: the design tools
 * must never leak component content or actor identities, and the monitoring
 * tools must degrade honestly when no Uptime Kuma API key is configured rather
 * than reporting zero monitors as though everything were fine.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotReader } from '../src/adapters/snapshots.js';
import { AuditLog } from '../src/logging/audit.js';
import { createLogger } from '../src/logging/logger.js';
import { ToolRegistry, ToolError } from '../src/tools/registry.js';
import { buildTools } from '../src/tools/definitions.js';
import { writeFixtureSnapshots, writeUnconfiguredMonitoring } from './helpers.js';

const logger = createLogger('silent');
let registry: ToolRegistry;
let unconfigured: ToolRegistry;

function run(reg: ToolRegistry, name: string, input: unknown = {}) {
  const tool = reg.get(name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool.handler(tool.inputSchema.parse(input), {
    requestId: 'test',
    subject: 'test-subject',
    signal: new AbortController().signal,
  });
}

beforeAll(() => {
  const auditDir = mkdtempSync(join(tmpdir(), 'carbo-mcp-new-audit-'));
  const audit = new AuditLog(auditDir, 1024 * 1024, 2, logger);
  audit.init();

  registry = new ToolRegistry();
  for (const t of buildTools({ snapshots: new SnapshotReader(writeFixtureSnapshots(), 300), audit })) {
    registry.register(t);
  }

  const dir = writeFixtureSnapshots();
  writeUnconfiguredMonitoring(dir);
  unconfigured = new ToolRegistry();
  for (const t of buildTools({ snapshots: new SnapshotReader(dir, 300), audit })) {
    unconfigured.register(t);
  }
});

describe('scoping', () => {
  it('puts the design tools behind carbo:design:read', () => {
    for (const n of ['carbo_get_design_status', 'carbo_list_design_components', 'carbo_get_design_publications', 'carbo_get_design_activity']) {
      expect(registry.get(n)!.scope).toBe('carbo:design:read');
      expect(registry.get(n)!.risk).toBe(1);
    }
  });

  it('puts the monitoring tools behind carbo:monitoring:read', () => {
    for (const n of ['carbo_get_monitoring_summary', 'carbo_list_monitors']) {
      expect(registry.get(n)!.scope).toBe('carbo:monitoring:read');
      expect(registry.get(n)!.risk).toBe(1);
    }
  });
});

describe('carbo_get_design_status', () => {
  it('summarizes projects, components and sites', async () => {
    const out = (await run(registry, 'carbo_get_design_status')) as any;
    expect(out.counts).toEqual({
      projects: 2, components: 2, components_published: 1,
      components_draft: 1, sites: 1, publications: 1,
    });
    expect(out.sites[0].slug).toBe('staging-wp');
  });
});

describe('carbo_list_design_components', () => {
  it('filters by status', async () => {
    const drafts = (await run(registry, 'carbo_list_design_components', { status: 'draft' })) as any;
    expect(drafts.components.map((c: any) => c.slug)).toEqual(['quotes']);
  });

  it('filters by project and by name substring', async () => {
    const byProject = (await run(registry, 'carbo_list_design_components', { project_slug: 'carbocomputers' })) as any;
    expect(byProject.total_matched).toBe(2);
    const byName = (await run(registry, 'carbo_list_design_components', { name_contains: 'quote' })) as any;
    expect(byName.total_matched).toBe(1);
  });

  it('returns no component markup, styles or scripts', async () => {
    const text = JSON.stringify(await run(registry, 'carbo_list_design_components'));
    expect(text).not.toMatch(/<[a-z]+|html|css|javascript|\{\s*"html"/i);
  });

  it('rejects a project slug with shell metacharacters', () => {
    const tool = registry.get('carbo_list_design_components')!;
    expect(() => tool.inputSchema.parse({ project_slug: 'x; rm -rf /' })).toThrow();
  });
});

describe('carbo_get_design_publications', () => {
  it('reports what is live and at which version', async () => {
    const out = (await run(registry, 'carbo_get_design_publications')) as any;
    expect(out.total).toBe(1);
    expect(out.publications[0]).toMatchObject({ site_slug: 'staging-wp', component_slug: 'hero', version: 3 });
  });

  it('gives an actionable not-found for an unknown site', async () => {
    await expect(run(registry, 'carbo_get_design_publications', { site_slug: 'nope' })).rejects.toThrow(
      /No Carbo Design site/,
    );
  });
});

describe('carbo_get_design_activity', () => {
  it('returns aggregate counts only, never actor identities', async () => {
    const out = (await run(registry, 'carbo_get_design_activity')) as any;
    expect(out.total_events).toBe(5);
    expect(out.failures).toBe(1);
    expect(out.top_actions[0]).toEqual({ action: 'component.update', count: 3 });
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/actor|ip|"detail"|@/i);
  });

  it('caps how many action types it returns', async () => {
    const out = (await run(registry, 'carbo_get_design_activity', { max_actions: 1 })) as any;
    expect(out.top_actions).toHaveLength(1);
  });
});

describe('carbo_get_monitoring_summary', () => {
  it('reports counts and names what is down', async () => {
    const out = (await run(registry, 'carbo_get_monitoring_summary')) as any;
    expect(out.counts).toEqual({ total: 3, up: 2, down: 1, other: 0 });
    expect(out.down).toEqual([{ name: 'Holiday Bail Bonds', status: 'down' }]);
  });

  it('surfaces certificates expiring inside the threshold, soonest first', async () => {
    const out = (await run(registry, 'carbo_get_monitoring_summary', { cert_warning_days: 70 })) as any;
    expect(out.certificates_expiring_soon.map((c: any) => c.days_remaining)).toEqual([12, 69]);
  });

  it('excludes certificates outside the threshold', async () => {
    const out = (await run(registry, 'carbo_get_monitoring_summary', { cert_warning_days: 20 })) as any;
    expect(out.certificates_expiring_soon).toHaveLength(1);
  });
});

describe('carbo_list_monitors', () => {
  it('filters by status', async () => {
    const out = (await run(registry, 'carbo_list_monitors', { status: 'down' })) as any;
    expect(out.monitors).toEqual([
      { name: 'Holiday Bail Bonds', status: 'down', response_time_ms: null, cert_days_remaining: 12 },
    ]);
  });

  it('filters by name substring', async () => {
    const out = (await run(registry, 'carbo_list_monitors', { name_contains: 'n8n' })) as any;
    expect(out.total_matched).toBe(1);
  });
});

describe('graceful degradation when Uptime Kuma has no API key', () => {
  it('says so, rather than reporting zero monitors as healthy', async () => {
    await expect(run(unconfigured, 'carbo_get_monitoring_summary')).rejects.toMatchObject({
      category: 'unavailable',
    });
    await expect(run(unconfigured, 'carbo_get_monitoring_summary')).rejects.toThrow(/API key/i);
  });

  it('applies to the list tool too', async () => {
    await expect(run(unconfigured, 'carbo_list_monitors')).rejects.toBeInstanceOf(ToolError);
  });

  it('leaves the design tools working', async () => {
    const out = (await run(unconfigured, 'carbo_get_design_status')) as any;
    expect(out.counts.projects).toBe(2);
  });
});
