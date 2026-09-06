/**
 * Redaction is the last line of defence between a log file and a leaked
 * credential, so these tests are adversarial: each case is a shape that has
 * actually appeared in this server's own logs or commit history.
 */
import { describe, expect, it } from 'vitest';
import { redact, redactString, summarizeParams, isSensitiveKey, REDACTED } from '../src/logging/redact.js';

describe('redactString', () => {
  it('removes JWTs wherever they appear', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIn0.eyJzdWIiOiJhYmMxMjM0NTY3ODkifQ.c2lnbmF0dXJlLXZhbHVlLWhlcmU';
    const out = redactString(`token was ${jwt} and then some`);
    expect(out).not.toContain('eyJhbGciOi');
    expect(out).toContain(REDACTED);
  });

  it('removes Authorization header values', () => {
    expect(redactString('Authorization: Bearer abc123def456ghi789')).not.toContain('abc123def456');
    expect(redactString('Authorization: Basic dXNlcjpwYXNzd29yZA==')).not.toContain('dXNlcjpwYXNz');
  });

  it('removes private keys', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----';
    expect(redactString(pem)).toBe(REDACTED);
  });

  it('removes provider-specific token formats', () => {
    expect(redactString('AKIAIOSFODNN7EXAMPLE')).toContain(REDACTED);
    expect(redactString('ghp_abcdefghijklmnopqrstuvwxyz0123')).toContain(REDACTED);
    expect(redactString('xoxb-123456789-abcdefghij')).toContain(REDACTED);
  });

  it('strips credentials embedded in a URL', () => {
    const out = redactString('postgres://keycloak:hunter2@db:5432/keycloak');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('postgres://[redacted]@');
  });

  it('redacts environment-variable assignments including non-keyword names', () => {
    // Regression: TOS_ACCESS_KEY_ID ends in "ID", so a keyword-suffix rule
    // alone let its value through. This shape is in a real commit subject here.
    const out = redactString('TOS_ACCESS_KEY_ID=AKIAREALVALUE123 DB_PASSWORD=hunter2');
    expect(out).not.toContain('AKIAREALVALUE123');
    expect(out).not.toContain('hunter2');
  });

  it('removes email addresses', () => {
    expect(redactString('contact info@carbocomputers.com now')).not.toContain('@carbocomputers.com');
  });

  it('leaves ordinary operational text intact', () => {
    const text = 'Container n8n is running, memory at 45.7%, disk at 40.7%';
    expect(redactString(text)).toBe(text);
  });
});

describe('redact (deep)', () => {
  it('replaces values of sensitive keys regardless of content', () => {
    const out = redact({ password: 'anything', client_secret: 'x', nested: { apiKey: 'y' } }) as Record<string, unknown>;
    expect(out.password).toBe(REDACTED);
    expect(out.client_secret).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).apiKey).toBe(REDACTED);
  });

  it('breaks cycles instead of overflowing the stack', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
    expect(JSON.stringify(redact(a))).toContain('circular');
  });

  it('bounds depth and array length', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(JSON.stringify(redact(deep))).toContain('truncated: depth');

    const long = Array.from({ length: 500 }, (_, i) => i);
    const out = redact(long) as unknown[];
    expect(out.length).toBeLessThanOrEqual(201);
  });

  it('reduces an Error to name and message without a stack', () => {
    const out = redact(new Error('failed for user bob@example.com')) as Record<string, string>;
    expect(out.name).toBe('Error');
    expect(out.message).not.toContain('bob@example.com');
    expect(out).not.toHaveProperty('stack');
  });
});

describe('isSensitiveKey', () => {
  it.each(['password', 'DB_PASSWORD', 'clientSecret', 'access_key', 'authorization', 'cookie', 'sessionId'])(
    'flags %s',
    (key) => expect(isSensitiveKey(key)).toBe(true),
  );

  it.each(['hostname', 'status', 'count', 'workflow_id'])('allows %s', (key) =>
    expect(isSensitiveKey(key)).toBe(false),
  );
});

describe('summarizeParams', () => {
  it('records shapes, never values', () => {
    const out = summarizeParams({ service_id: 'n8n', limit: 20, flag: true, list: [1, 2], nested: { a: 1 } });
    expect(out).toEqual({
      service_id: 'string(3)',
      limit: '20',
      flag: 'true',
      list: 'array(2)',
      nested: 'object(1)',
    });
    expect(JSON.stringify(out)).not.toContain('n8n');
  });

  it('redacts a sensitive key even in the shape summary', () => {
    expect(summarizeParams({ token: 'abc' }).token).toBe(REDACTED);
  });
});
