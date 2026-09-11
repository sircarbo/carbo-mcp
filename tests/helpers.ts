/**
 * Test scaffolding.
 *
 * The token tests deliberately exercise the real verification path rather than
 * stubbing it: a genuine RSA keypair is generated, a genuine JWKS is served
 * over a real socket, and jose fetches it the same way it will fetch
 * Keycloak's in production. A mocked verifier would prove nothing about the
 * code that actually guards the gateway.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyObject } from 'jose';
import type { AddressInfo } from 'node:net';

export const TEST_ISSUER = 'https://mcp.test.invalid/realms/carbo';
export const TEST_AUDIENCE = 'https://mcp.test.invalid/mcp';
export const TEST_ORIGIN = 'https://mcp.test.invalid';

export interface TestKeys {
  privateKey: KeyObject | CryptoKey;
  jwksUri: string;
  close: () => Promise<void>;
}

/** Generates a keypair and serves its public half as a JWKS document. */
export async function startJwksServer(): Promise<TestKeys> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk: JWK = await exportJWK(publicKey);
  jwk.kid = 'test-key-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  const server: Server = createServer((req, res) => {
    if (req.url === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    privateKey: privateKey as KeyObject,
    jwksUri: `http://127.0.0.1:${port}/jwks`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface TokenOptions {
  subject?: string;
  scopes?: string[];
  audience?: string | string[];
  issuer?: string;
  expiresInSeconds?: number;
  notBeforeOffsetSeconds?: number;
  clientId?: string;
}

/** Mints a token with whatever defects a given test needs. */
export async function mintToken(keys: TestKeys, opts: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (opts.expiresInSeconds ?? 300);

  const jwt = new SignJWT({
    scope: (opts.scopes ?? []).join(' '),
    azp: opts.clientId ?? 'claude-ai-connector',
    preferred_username: 'carbo',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setSubject(opts.subject ?? 'test-subject-1')
    .setIssuer(opts.issuer ?? TEST_ISSUER)
    .setAudience(opts.audience ?? TEST_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(exp);

  if (opts.notBeforeOffsetSeconds !== undefined) {
    jwt.setNotBefore(now + opts.notBeforeOffsetSeconds);
  }

  return jwt.sign(keys.privateKey as KeyObject);
}

/** Writes a complete, realistic snapshot set to a throwaway directory. */
export function writeFixtureSnapshots(collectedAt = new Date().toISOString()): string {
  const dir = mkdtempSync(join(tmpdir(), 'carbo-mcp-fixtures-'));
  mkdirSync(dir, { recursive: true });

  const put = (name: string, data: unknown) =>
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ collected_at: collectedAt, data }));

  put('system', {
    hostname: 'carbo-server',
    os: 'Debian GNU/Linux 13 (trixie)',
    kernel: '6.12.107+deb13-amd64',
    architecture: 'x86_64',
    uptimeSeconds: 91043,
    loadAverage: { one: 0.44, five: 0.71, fifteen: 0.75 },
    cpu: { cores: 4, usagePercent: 13.3 },
    memory: { totalMb: 32071, usedMb: 14644, availableMb: 17427, usedPercent: 45.7 },
    swap: { totalMb: 32734, usedMb: 2, usedPercent: 0.0 },
    disks: [
      { mount: '/', filesystem: '', totalGb: 948, usedGb: 386.1, availableGb: 513.6, usedPercent: 40.7 },
    ],
  });

  put('containers', [
    {
      name: 'n8n',
      image: 'n8nio/n8n:2.35.7',
      state: 'running',
      health: 'none',
      status: 'Up 25 hours',
      restartPolicy: 'unless-stopped',
      restartCount: 0,
      startedAt: '2026-09-04T14:07:00Z',
      publishedPorts: ['0.0.0.0:5678->5678/tcp'],
    },
    {
      name: 'broken-service',
      image: 'example:1',
      state: 'running',
      health: 'unhealthy',
      status: 'Up 2 hours',
      restartPolicy: 'unless-stopped',
      restartCount: 7,
      startedAt: '2026-09-05T12:00:00Z',
      publishedPorts: [],
    },
    {
      name: 'stopped-service',
      image: 'hello-world',
      state: 'exited',
      health: 'none',
      status: 'exited',
      restartPolicy: 'no',
      restartCount: 0,
      startedAt: null,
      publishedPorts: [],
    },
  ]);

  put('services', [
    {
      id: 'n8n',
      name: 'n8n',
      category: 'automation',
      description: 'Workflow automation engine',
      container: 'n8n',
      probe: { kind: 'http', target: 'http://127.0.0.1:5678/healthz' },
      status: 'up',
      httpStatus: 200,
      responseTimeMs: 1,
      lastCheckedAt: collectedAt,
      note: null,
    },
    {
      id: 'wordpress-local',
      name: 'WordPress (local)',
      category: 'web',
      description: 'Local WordPress instance',
      container: 'wordpress',
      probe: { kind: 'http', target: 'http://127.0.0.1:8080/' },
      status: 'down',
      httpStatus: null,
      responseTimeMs: null,
      lastCheckedAt: collectedAt,
      note: null,
    },
  ]);

  put('websites', [
    {
      domain: 'carbocomputers.com',
      label: 'Carbo Computers',
      host: 'Linode WP',
      status: 'up',
      httpStatus: 200,
      responseTimeMs: 120,
      tls: { valid: true, expiresAt: '2026-11-13T00:00:00Z', daysRemaining: 69 },
      lastCheckedAt: collectedAt,
    },
  ]);

  put('n8n', {
    reachable: true,
    healthStatus: 'ok',
    workflows: [
      { id: 'wf1', name: 'HBB - Weekly SEO Report', active: true, updatedAt: '2026-09-01T10:00:00Z', nodeCount: 10 },
      { id: 'wf2', name: 'Inactive workflow', active: false, updatedAt: '2026-08-01T10:00:00Z', nodeCount: 4 },
    ],
    executions: [
      { id: '453', workflowId: 'wf1', workflowName: 'HBB - Weekly SEO Report', status: 'success', startedAt: '2026-09-05T13:00:46Z', finishedAt: '2026-09-05T13:01:10Z', durationMs: 23901 },
      { id: '452', workflowId: 'wf1', workflowName: 'HBB - Weekly SEO Report', status: 'error', startedAt: '2026-09-05T11:02:28Z', finishedAt: '2026-09-05T11:02:31Z', durationMs: 2730 },
    ],
    counts: { workflowsTotal: 2, workflowsActive: 1, executionsSampled: 2 },
  });

  put('video', {
    pipelineName: 'Video Factory v2',
    lastBatchRunAt: 'Sat 2026-09-05 02:00:01 EDT',
    lastBatchResult: 'success',
    nextScheduledRunAt: 'Sun 2026-09-06 02:00:00 EDT',
    jobs: [
      {
        id: 'job-1',
        name: 'Highlight reel',
        state: 'failed',
        stage: 'render',
        progressPercent: 42,
        createdAt: '2026-09-05T02:00:00Z',
        updatedAt: '2026-09-05T02:05:00Z',
        errorSummary: 'ffmpeg exited with code 1 token=abcdefghijklmnopqrstuvwxyz0123456789012345',
      },
    ],
    outputs: { count: 8, latestAt: '2026-08-10T22:37:00Z', totalSizeMb: 100.3 },
    counts: { failed: 1 },
  });

  put('backups', [
    {
      id: 'carbo-design-db',
      name: 'Carbo Design database backup',
      schedule: 'Daily at 02:30',
      lastRunAt: collectedAt,
      ageHours: 6.5,
      status: 'ok',
      artifactCount: 30,
      latestArtifactSizeKb: 15.3,
      retentionNote: '30-day retention',
    },
    {
      id: 'stale-job',
      name: 'Stale job',
      schedule: 'Daily',
      lastRunAt: '2026-08-01T00:00:00Z',
      ageHours: 840,
      status: 'stale',
      artifactCount: 1,
      latestArtifactSizeKb: 1,
      retentionNote: null,
    },
  ]);

  put('projects', [
    {
      id: 'carbo-design',
      name: 'Carbo Design',
      path: '/opt/carbo-design',
      branch: 'main',
      dirty: true,
      changedFileCount: 2,
      lastCommit: { shortSha: 'abc123def456', subject: 'ops: nightly backup', authoredAt: '2026-09-04T18:00:00Z' },
      aheadBehind: { ahead: 1, behind: 0 },
      status: '2 uncommitted changes',
    },
    {
      id: 'clean-project',
      name: 'Clean project',
      path: '/opt/clean',
      branch: 'main',
      dirty: false,
      changedFileCount: 0,
      lastCommit: null,
      aheadBehind: null,
      status: 'clean',
    },
  ]);

  put('errors', {
    sources: [
      {
        source: 'container:n8n',
        windowHours: 24,
        errorCount: 3,
        warningCount: 1,
        topPatterns: [
          { pattern: 'ERROR failed to connect to db at [ip]', count: 3, lastSeenAt: '2026-09-05T10:00:00Z' },
        ],
      },
    ],
    securityScan: { lastRunAt: '2026-09-05T05:00:22Z', findingsCount: 3, severitySummary: '3 line(s) flagged for review' },
  });

  put('design', {
    reachable: true,
    projects: [
      { id: 'p1', slug: 'carbocomputers', name: 'Carbo Computers', description: '', componentCount: 2, updatedAt: '2026-09-04T18:00:00Z' },
      { id: 'p2', slug: 'empty-project', name: 'Empty', description: '', componentCount: 0, updatedAt: null },
    ],
    components: [
      { id: 'c1', slug: 'hero', name: 'Hero', kind: 'hero', status: 'published', projectSlug: 'carbocomputers', latestVersion: 3, updatedAt: '2026-09-04T19:00:00Z' },
      { id: 'c2', slug: 'quotes', name: 'Client quotes', kind: 'testimonial_carousel', status: 'draft', projectSlug: 'carbocomputers', latestVersion: 1, updatedAt: '2026-09-03T10:00:00Z' },
    ],
    sites: [
      { slug: 'staging-wp', name: 'Staging WordPress', environment: 'staging', baseUrl: 'http://10.0.0.39:8080', isActive: true, publishedCount: 1 },
    ],
    publications: [
      { siteSlug: 'staging-wp', componentSlug: 'hero', componentName: 'Hero', version: 3, publishedAt: '2026-09-04T19:05:00Z' },
    ],
    activity: {
      windowHours: 24,
      total: 5,
      byAction: [{ action: 'component.update', count: 3 }, { action: 'auth.login', count: 2 }],
      failures: 1,
      lastEventAt: '2026-09-05T01:19:39Z',
    },
    counts: { projects: 2, components: 2, componentsPublished: 1, componentsDraft: 1, sites: 1, publications: 1 },
  });

  put('terminal', {
    overall: 'up',
    container: { state: 'running', health: 'healthy', image: 'wettyoss/wetty' },
    backend: { status: 'up', httpStatus: 200, responseTimeMs: 4 },
    tailscaleServeActive: true,
    doors: [
      { id: 'tailscale', url: 'https://carbo-server.tailca00c8.ts.net:8443/', status: 'up', httpStatus: 200, responseTimeMs: 12, note: 'Tailscale Serve' },
      { id: 'apache-port', url: 'https://100.71.174.8:8444/', status: 'up', httpStatus: 200, responseTimeMs: 6, note: 'Apache port' },
      { id: 'apache-name', url: 'https://terminal.carbo.lan/', status: 'down', httpStatus: null, responseTimeMs: null, note: 'Apache name' },
    ],
    watchdog: { timerActive: true, lastResult: 'success', lastRunAt: collectedAt },
    recentWatchdogEvents: ['[2026-09-11 17:37:16] [WETTY_WATCHDOG] [FAILED] Apache front door on :8444 not answering; reloading apache2'],
    sshTarget: 'sircarbo@10.0.0.39 (password authentication, host key pinned)',
  });

  put('monitoring', {
    reachable: true,
    configured: true,
    note: null,
    source: 'uptime-kuma (EC2, over Tailscale)',
    monitors: [
      { name: 'Carbo Computers', status: 'up', responseTimeMs: 120, certDaysRemaining: 69 },
      { name: 'Holiday Bail Bonds', status: 'down', responseTimeMs: null, certDaysRemaining: 12 },
      { name: 'n8n (carbo-server)', status: 'up', responseTimeMs: 4, certDaysRemaining: null },
    ],
    counts: { total: 3, up: 2, down: 1, other: 0 },
  });

  return dir;
}

/** A snapshot set where Uptime Kuma has no API key, to test graceful degradation. */
export function writeUnconfiguredMonitoring(dir: string, collectedAt = new Date().toISOString()): void {
  writeFileSync(
    join(dir, 'monitoring.json'),
    JSON.stringify({
      collected_at: collectedAt,
      data: {
        reachable: false,
        configured: false,
        note: 'No Uptime Kuma API key configured. Create one in Uptime Kuma under Settings > API Keys and save it to secrets/uptime_kuma_api_key.',
        source: 'uptime-kuma (EC2, over Tailscale)',
        monitors: [],
        counts: { total: 0, up: 0, down: 0, other: 0 },
      },
    }),
  );
}
