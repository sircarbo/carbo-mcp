/**
 * Protocol-level auditing.
 *
 * The gap this covers is a real one that bit during deployment: with only
 * tool_call and auth_failure recorded, the audit log could not answer "did the
 * connector actually connect?", and a transport-level rejection was invisible
 * outside the reverse proxy's access log.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { parseMessages, outcomeForStatus } from '../src/server/protocolAudit.js';
import { createApp } from '../src/server/index.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logging/logger.js';
import { AuditLog, type AuditEvent } from '../src/logging/audit.js';
import { SnapshotReader } from '../src/adapters/snapshots.js';
import { TokenVerifier } from '../src/auth/tokenVerifier.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { buildTools } from '../src/tools/definitions.js';
import {
  mintToken,
  startJwksServer,
  writeFixtureSnapshots,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_ORIGIN,
  type TestKeys,
} from './helpers.js';

describe('parseMessages', () => {
  it('reads a single request', () => {
    const [m] = parseMessages({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(m).toMatchObject({ method: 'tools/list', isNotification: false });
  });

  it('treats a message with no id as a notification', () => {
    const [m] = parseMessages({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(m?.isNotification).toBe(true);
  });

  it('pulls client identity and protocol version out of initialize', () => {
    const [m] = parseMessages({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', clientInfo: { name: 'Claude', version: '1.2.3' } },
    });
    expect(m).toMatchObject({
      method: 'initialize',
      clientName: 'Claude',
      clientVersion: '1.2.3',
      protocolVersion: '2025-06-18',
    });
  });

  it('handles a batch and caps how many it will record', () => {
    const batch = Array.from({ length: 50 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }));
    expect(parseMessages(batch)).toHaveLength(20);
  });

  it('ignores anything that is not a JSON-RPC message', () => {
    expect(parseMessages(null)).toEqual([]);
    expect(parseMessages('a string')).toEqual([]);
    expect(parseMessages({ no: 'method' })).toEqual([]);
    expect(parseMessages([1, 2, 3])).toEqual([]);
  });

  it('bounds attacker-controlled strings', () => {
    const [m] = parseMessages({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { clientInfo: { name: 'x'.repeat(5000), version: 'y'.repeat(5000) } },
    });
    expect(m!.clientName!.length).toBeLessThanOrEqual(80);
    expect(m!.clientVersion!.length).toBeLessThanOrEqual(40);
  });
});

describe('outcomeForStatus', () => {
  it.each([
    [200, 'success'], [202, 'success'], [401, 'denied'], [403, 'denied'],
    [429, 'rate_limited'], [504, 'timeout'], [400, 'error'], [500, 'error'],
  ])('%i maps to %s', (status, expected) => {
    expect(outcomeForStatus(status as number)).toBe(expected);
  });
});

describe('audit records written for real requests', () => {
  let keys: TestKeys;
  let server: Server;
  let baseUrl: string;
  let auditDir: string;

  const MCP_HEADERS = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };

  const readAudit = (): AuditEvent[] => {
    const path = join(auditDir, 'audit.log');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditEvent);
  };

  beforeAll(async () => {
    keys = await startJwksServer();
    auditDir = mkdtempSync(join(tmpdir(), 'carbo-mcp-proto-audit-'));

    const cfg = loadConfig({
      MCP_PUBLIC_ORIGIN: TEST_ORIGIN,
      MCP_RESOURCE_IDENTIFIER: TEST_AUDIENCE,
      OAUTH_ISSUER: TEST_ISSUER,
      OAUTH_JWKS_URI: keys.jwksUri,
      MCP_SNAPSHOT_DIR: writeFixtureSnapshots(),
      MCP_AUDIT_DIR: auditDir,
      MCP_RATE_LIMIT_MAX: '1000',
      MCP_AUTH_RATE_LIMIT_MAX: '1000',
    } as NodeJS.ProcessEnv);

    const logger = createLogger('silent');
    const audit = new AuditLog(auditDir, 1024 * 1024, 3, logger);
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
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await keys.close();
  });

  const post = async (body: unknown, token: string, extra: Record<string, string> = {}) => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: `Bearer ${token}`, ...extra },
      body: JSON.stringify(body),
    });
    await res.text();
    // The record is written on the response 'finish' event.
    await new Promise((r) => setTimeout(r, 80));
    return res;
  };

  it('records a successful initialize with the client identity', async () => {
    const token = await mintToken(keys, { scopes: ['carbo:server:read'] });
    await post(
      {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'Claude', version: '9.9.9' },
        },
      },
      token,
    );

    const rec = readAudit().filter((e) => e.event === 'initialize').at(-1);
    expect(rec).toBeDefined();
    expect(rec!.outcome).toBe('success');
    expect(rec!.httpStatus).toBe(200);
    expect(rec!.method).toBe('initialize');
    expect(rec!.detail?.clientName).toBe('Claude');
    expect(rec!.detail?.clientVersion).toBe('9.9.9');
    expect(rec!.subject).toBe('test-subject-1');
    expect(typeof rec!.durationMs).toBe('number');
  });

  it('records a tools/list', async () => {
    const token = await mintToken(keys, { scopes: ['carbo:n8n:read'] });
    await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, token);

    const rec = readAudit().filter((e) => e.event === 'tools_list').at(-1);
    expect(rec).toBeDefined();
    expect(rec!.outcome).toBe('success');
    expect(rec!.httpStatus).toBe(200);
  });

  it('records a transport rejection, which was previously invisible', async () => {
    // This is exactly what Claude.ai's version probe produces: the transport
    // refuses an unsupported MCP-Protocol-Version before any handler runs.
    const token = await mintToken(keys, { scopes: ['carbo:server:read'] });
    const res = await post(
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      token,
      { 'MCP-Protocol-Version': '2099-01-01' },
    );
    expect(res.status).toBe(400);

    const rec = readAudit().filter((e) => e.httpStatus === 400).at(-1);
    expect(rec).toBeDefined();
    expect(rec!.outcome).toBe('error');
    expect(rec!.errorCategory).toBe('http_400');
    expect(rec!.detail?.requestedProtocolVersion).toBe('2099-01-01');
  });

  it('does not record a successful notification as noise', async () => {
    const token = await mintToken(keys, { scopes: ['carbo:server:read'] });
    const before = readAudit().length;
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, token);
    expect(readAudit().length).toBe(before);
  });

  it('does not double-record a tool call', async () => {
    const token = await mintToken(keys, { scopes: ['carbo:server:read'] });
    const before = readAudit().filter((e) => e.event === 'tool_call').length;
    await post(
      {
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'carbo_get_server_health', arguments: {} },
      },
      token,
    );
    const after = readAudit().filter((e) => e.event === 'tool_call');
    expect(after.length).toBe(before + 1);
    // The tool call must not also appear as a protocol event.
    expect(readAudit().filter((e) => e.method === 'tools/call')).toHaveLength(0);
  });

  it('never writes a token or header value into a protocol record', () => {
    const text = JSON.stringify(readAudit());
    expect(text).not.toMatch(/eyJ|Bearer |authorization/i);
  });
});
