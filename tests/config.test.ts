/**
 * Configuration is validated once at startup and the process aborts on
 * failure, so these tests pin the boundary between "starts" and "refuses to".
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, describeConfig, ALL_SCOPES, advertisedScopes } from '../src/config.js';

const valid = {
  MCP_PUBLIC_ORIGIN: 'https://mcp.example.com',
  MCP_RESOURCE_IDENTIFIER: 'https://mcp.example.com/mcp',
  OAUTH_ISSUER: 'https://mcp.example.com/realms/carbo',
  OAUTH_JWKS_URI: 'http://carbo-keycloak:8080/realms/carbo/protocol/openid-connect/certs',
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('accepts a complete configuration and applies defaults', () => {
    const cfg = loadConfig(valid);
    expect(cfg.port).toBe(8110);
    expect(cfg.requestTimeoutMs).toBe(30000);
    expect(cfg.trustProxyHops).toBe(1);
    expect(cfg.allowedSubjects).toEqual([]);
  });

  it('refuses to start without an issuer', () => {
    const { OAUTH_ISSUER: _drop, ...rest } = valid;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/Invalid configuration/);
  });

  it('refuses a plaintext public origin', () => {
    expect(() => loadConfig({ ...valid, MCP_PUBLIC_ORIGIN: 'http://mcp.example.com' })).toThrow(
      /https/,
    );
  });

  it('refuses a plaintext issuer', () => {
    expect(() => loadConfig({ ...valid, OAUTH_ISSUER: 'http://mcp.example.com/realms/carbo' })).toThrow(
      /https/,
    );
  });

  it('rejects an out-of-range body limit rather than clamping it silently', () => {
    expect(() => loadConfig({ ...valid, MCP_MAX_BODY_BYTES: '99999999' })).toThrow(/Invalid configuration/);
  });

  it('parses a subject allowlist', () => {
    const cfg = loadConfig({ ...valid, MCP_ALLOWED_SUBJECTS: 'sub-a, sub-b ,sub-c' });
    expect(cfg.allowedSubjects).toEqual(['sub-a', 'sub-b', 'sub-c']);
  });

  it('defaults the resource identifier to the public origin', () => {
    const { MCP_RESOURCE_IDENTIFIER: _drop, ...rest } = valid;
    expect(loadConfig(rest as NodeJS.ProcessEnv).resourceIdentifier).toBe('https://mcp.example.com');
  });
});

describe('describeConfig', () => {
  it('summarizes without emitting anything secret-shaped', () => {
    const summary = JSON.stringify(describeConfig(loadConfig(valid)));
    expect(summary).toContain('mcp.example.com');
    expect(summary).not.toMatch(/password|secret|token=/i);
  });

  it('exposes exactly the documented scope set', () => {
    expect([...ALL_SCOPES]).toEqual([
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
      'carbo:kling:generate',
    ]);
  });

  it('advertises the generate scope only when an elevated tool is enabled', () => {
    expect(advertisedScopes({ elevatedTools: [] })).not.toContain('carbo:kling:generate');
    expect(advertisedScopes({ elevatedTools: ['kling_video_status'] })).toContain('carbo:kling:generate');
  });
});
