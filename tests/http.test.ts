/**
 * End-to-end HTTP behaviour against a real listening socket: the auth boundary,
 * the discovery documents, the MCP protocol surface, and the request limits.
 *
 * These are the tests that decide whether the deployment is safe to expose, so
 * every rejection path is asserted explicitly rather than assumed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/server/index.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logging/logger.js';
import { AuditLog } from '../src/logging/audit.js';
import { SnapshotReader } from '../src/adapters/snapshots.js';
import { TokenVerifier } from '../src/auth/tokenVerifier.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { buildTools } from '../src/tools/definitions.js';
import { mintToken, startJwksServer, TEST_AUDIENCE, TEST_ISSUER, TEST_ORIGIN, type TestKeys } from './helpers.js';

let keys: TestKeys;
let server: Server;
let baseUrl: string;

const ALL_SCOPES = [
  'carbo:server:read',
  'carbo:docker:read',
  'carbo:video:read',
  'carbo:n8n:read',
  'carbo:websites:read',
  'carbo:backups:read',
  'carbo:projects:read',
  'carbo:audit:read',
  'carbo:design:read',
  'carbo:monitoring:read',
];

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

async function rpc(body: unknown, token?: string, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...MCP_HEADERS, ...extraHeaders };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Some responses are event-stream framed; pull the first data payload out.
    const match = /^data: (.+)$/m.exec(text);
    if (match) json = JSON.parse(match[1]!);
  }
  return { res, json, text };
}

beforeAll(async () => {
  keys = await startJwksServer();

  const { writeFixtureSnapshots } = await import('./helpers.js');
  const cfg = loadConfig({
    MCP_PUBLIC_ORIGIN: TEST_ORIGIN,
    MCP_RESOURCE_IDENTIFIER: TEST_AUDIENCE,
    OAUTH_ISSUER: TEST_ISSUER,
    OAUTH_JWKS_URI: keys.jwksUri,
    MCP_SNAPSHOT_DIR: writeFixtureSnapshots(),
    MCP_MAX_BODY_BYTES: '4096',
    MCP_RATE_LIMIT_MAX: '1000',
    MCP_AUTH_RATE_LIMIT_MAX: '1000',
    MCP_TRUST_PROXY_HOPS: '1',
  } as NodeJS.ProcessEnv);

  const logger = createLogger('silent');
  const audit = new AuditLog(mkdtempSync(join(tmpdir(), 'carbo-mcp-http-audit-')), 1024 * 1024, 3, logger);
  audit.init();

  const snapshots = new SnapshotReader(cfg.snapshotDir, cfg.snapshotMaxAgeSeconds);
  const registry = new ToolRegistry();
  for (const tool of buildTools({ snapshots, audit })) registry.register(tool);

  const verifier = new TokenVerifier({
    jwksUri: cfg.jwksUri,
    expectedIssuer: cfg.issuer,
    expectedAudience: cfg.resourceIdentifier,
    clockToleranceSeconds: cfg.clockToleranceSeconds,
    allowedSubjects: [],
  });

  const app = createApp(cfg, logger, audit, registry, snapshots, verifier);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await keys.close();
});

describe('health and readiness', () => {
  it('serves liveness without authentication and without detail', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    // Liveness must not become a reconnaissance endpoint.
    expect(Object.keys(body).sort()).toEqual(['service', 'status', 'timestamp', 'version']);
  });

  it('serves readiness with snapshot ages only', async () => {
    const res = await fetch(`${baseUrl}/ready`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ready');
    expect(body.snapshots.system).toMatch(/^fresh/);
    expect(JSON.stringify(body)).not.toMatch(/\/app|\/opt|token|secret/i);
  });

  it('sets no-store on every response', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('protected resource metadata', () => {
  it('is served unauthenticated at the path-suffixed location', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe(TEST_AUDIENCE);
    expect(body.authorization_servers).toEqual([TEST_ISSUER]);
    // A read-only deployment must not advertise the paid generate scope.
    expect(body.scopes_supported).toEqual(ALL_SCOPES.filter((s) => s !== 'carbo:kling:generate'));
    expect(body.bearer_methods_supported).toEqual(['header']);
  });

  it('is also served at the bare location for lenient clients', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
  });
});

describe('authentication boundary', () => {
  it('rejects an unauthenticated MCP request and points at the metadata', async () => {
    const { res, json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('Bearer realm="carbo-mcp"');
    expect(challenge).toContain('/.well-known/oauth-protected-resource/mcp');
    expect(json.error).toBe('invalid_request');
  });

  it('rejects a non-Bearer authorization scheme', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: 'Basic dXNlcjpwYXNz' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a garbage token', async () => {
    const { res } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'not.a.token');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('invalid_token');
  });

  it('rejects an expired token', async () => {
    const token = await mintToken(keys, { scopes: ALL_SCOPES, expiresInSeconds: -600 });
    const { res, json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, token);
    expect(res.status).toBe(401);
    expect(json.error_description).toMatch(/expired/i);
  });

  it('rejects a token minted for another audience', async () => {
    const token = await mintToken(keys, { scopes: ALL_SCOPES, audience: 'https://elsewhere.example/mcp' });
    const { res, json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, token);
    expect(res.status).toBe(401);
    expect(json.error_description).toMatch(/audience/i);
  });

  it('rejects a token from another issuer', async () => {
    const token = await mintToken(keys, { scopes: ALL_SCOPES, issuer: 'https://evil.example/realms/x' });
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, token)).res.status).toBe(401);
  });

  it('rejects a token signed by an unknown key', async () => {
    const other = await startJwksServer();
    try {
      const token = await mintToken(other, { scopes: ALL_SCOPES });
      expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, token)).res.status).toBe(401);
    } finally {
      await other.close();
    }
  });

  it('never leaks an internal path or exception text in a rejection', async () => {
    const { text } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'garbage');
    expect(text).not.toMatch(/\/app\/|\/opt\/|node_modules|at Object\./);
  });
});

describe('MCP protocol surface', () => {
  it('completes initialization for an authenticated caller', async () => {
    const token = await mintToken(keys, { scopes: ALL_SCOPES });
    const { res, json } = await rpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'vitest', version: '1.0.0' },
        },
      },
      token,
    );
    expect(res.status).toBe(200);
    expect(json.result.serverInfo.name).toBe('carbo-mcp-gateway');
    expect(json.result.capabilities.tools).toBeDefined();
    expect(json.result.instructions).toMatch(/read-only/i);
  });

  it('lists every tool for a fully scoped caller', async () => {
    const token = await mintToken(keys, { scopes: ALL_SCOPES });
    const { json } = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, token);
    const names = json.result.tools.map((t: any) => t.name).sort();
    expect(names).toHaveLength(22);
    expect(names).toContain('carbo_get_server_health');
    // Descriptions must state the limits, not just the capability.
    for (const tool of json.result.tools) {
      expect(tool.description).toMatch(/cannot|never|excluded/i);
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
    }
  });

  it('shows only the tools the caller\'s scopes authorize', async () => {
    const token = await mintToken(keys, { scopes: ['carbo:n8n:read'] });
    const { json } = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, token);
    const names = json.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(['carbo_get_n8n_execution_status', 'carbo_list_n8n_workflows']);
  });

  it('refuses a token that carries no gateway scope at all', async () => {
    const token = await mintToken(keys, { scopes: ['openid', 'profile'] });
    const { res, json } = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, token);
    // Authenticated but unauthorized is a 403, not an empty success.
    expect(res.status).toBe(403);
    expect(json.error).toBe('insufficient_scope');
    const challenge = res.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('carbo:server:read');
  });

  it('executes a real read-only tool', async () => {
    const token = await mintToken(keys, { scopes: ALL_SCOPES });
    const { json } = await rpc(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'carbo_get_server_health', arguments: {} } },
      token,
    );
    expect(json.result.isError).toBeFalsy();
    const payload = JSON.parse(json.result.content[0].text);
    expect(payload.hostname).toBe('carbo-server');
    expect(payload.freshness.fresh).toBe(true);
  });

  it('refuses a tool the caller has no scope for', async () => {
    const token = await mintToken(keys, { scopes: ['carbo:n8n:read'] });
    const { json } = await rpc(
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'carbo_get_server_health', arguments: {} } },
      token,
    );
    // The tool is not registered for this caller, so the protocol refuses it.
    expect(json.error ?? json.result?.isError).toBeTruthy();
    expect(JSON.stringify(json)).toMatch(/not found|unknown tool|insufficient/i);
  });

  it('rejects arguments that violate the input schema', async () => {
    const token = await mintToken(keys, { scopes: ALL_SCOPES });
    const { json } = await rpc(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'carbo_list_container_status', arguments: { limit: 99999 } },
      },
      token,
    );
    expect(json.error ?? json.result?.isError).toBeTruthy();
  });

  it('refuses GET and DELETE on the MCP endpoint', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${baseUrl}/mcp`, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });
});

describe('request limits', () => {
  it('rejects an oversized body before authentication work happens', async () => {
    const huge = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(20000) } });
    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: huge });
    expect(res.status).toBe(413);
  });

  it('rejects a malformed JSON body', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: '{not json' });
    expect(res.status).toBe(400);
  });

  it('returns a correlation id on every response', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes a safe client-supplied correlation id but replaces a hostile one', async () => {
    const safe = await fetch(`${baseUrl}/health`, { headers: { 'x-request-id': 'abc123def456' } });
    expect(safe.headers.get('x-request-id')).toBe('abc123def456');

    const hostile = await fetch(`${baseUrl}/health`, { headers: { 'x-request-id': '<script>alert(1)</script>' } });
    expect(hostile.headers.get('x-request-id')).not.toContain('<script>');
  });
});

describe('unknown routes', () => {
  it.each(['/', '/admin', '/.env', '/docs', '/metrics', '/realms/carbo'])(
    'returns a bare 404 for %s',
    async (path) => {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    },
  );
});

describe('rate limiting', () => {
  it('refuses once the unauthenticated budget is spent', async () => {
    const { loadConfig: load } = await import('../src/config.js');
    const { writeFixtureSnapshots } = await import('./helpers.js');
    const cfg = load({
      MCP_PUBLIC_ORIGIN: TEST_ORIGIN,
      MCP_RESOURCE_IDENTIFIER: TEST_AUDIENCE,
      OAUTH_ISSUER: TEST_ISSUER,
      OAUTH_JWKS_URI: keys.jwksUri,
      MCP_SNAPSHOT_DIR: writeFixtureSnapshots(),
      MCP_AUTH_RATE_LIMIT_MAX: '3',
      MCP_RATE_LIMIT_MAX: '3',
    } as NodeJS.ProcessEnv);

    const logger = createLogger('silent');
    const audit = new AuditLog(mkdtempSync(join(tmpdir(), 'carbo-mcp-rl-')), 1024 * 1024, 2, logger);
    audit.init();
    const snapshots = new SnapshotReader(cfg.snapshotDir, cfg.snapshotMaxAgeSeconds);
    const registry = new ToolRegistry();
    for (const tool of buildTools({ snapshots, audit })) registry.register(tool);
    const verifier = new TokenVerifier({
      jwksUri: cfg.jwksUri,
      expectedIssuer: cfg.issuer,
      expectedAudience: cfg.resourceIdentifier,
      clockToleranceSeconds: 30,
      allowedSubjects: [],
    });

    const app = createApp(cfg, logger, audit, registry, snapshots, verifier);
    const limited = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => limited.once('listening', () => resolve()));
    const url = `http://127.0.0.1:${(limited.address() as AddressInfo).port}/mcp`;

    try {
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await fetch(url, {
          method: 'POST',
          headers: MCP_HEADERS,
          body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/list' }),
        });
        codes.push(res.status);
      }
      expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => limited.close(() => resolve()));
    }
  });
});
