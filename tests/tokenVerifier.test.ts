/**
 * Token validation, exercised against a real JWKS served over a real socket.
 * Each test corresponds to one way a token can be wrong; all of them must be
 * refused, and none of the refusals may echo token contents back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthError, TokenVerifier, extractScopes } from '../src/auth/tokenVerifier.js';
import { mintToken, startJwksServer, TEST_AUDIENCE, TEST_ISSUER, type TestKeys } from './helpers.js';

let keys: TestKeys;
let verifier: TokenVerifier;

beforeAll(async () => {
  keys = await startJwksServer();
  verifier = new TokenVerifier({
    jwksUri: keys.jwksUri,
    expectedIssuer: TEST_ISSUER,
    expectedAudience: TEST_AUDIENCE,
    clockToleranceSeconds: 5,
    allowedSubjects: [],
  });
});

afterAll(async () => {
  await keys.close();
});

describe('TokenVerifier', () => {
  it('accepts a correctly signed, correctly scoped token', async () => {
    const token = await mintToken(keys, { scopes: ['carbo:server:read', 'carbo:docker:read'] });
    const ctx = await verifier.verify(token);
    expect(ctx.subject).toBe('test-subject-1');
    expect(ctx.clientId).toBe('claude-ai-connector');
    expect([...ctx.scopes].sort()).toEqual(['carbo:docker:read', 'carbo:server:read']);
  });

  it('rejects a token that is not a JWS at all', async () => {
    await expect(verifier.verify('not-a-token')).rejects.toMatchObject({ code: 'malformed_token' });
  });

  it('rejects a token signed by the wrong key', async () => {
    const other = await startJwksServer();
    try {
      const token = await mintToken(other, { scopes: ['carbo:server:read'] });
      await expect(verifier.verify(token)).rejects.toMatchObject({ code: 'invalid_signature' });
    } finally {
      await other.close();
    }
  });

  it('rejects an expired token', async () => {
    const token = await mintToken(keys, { expiresInSeconds: -600 });
    await expect(verifier.verify(token)).rejects.toMatchObject({ code: 'expired_token' });
  });

  it('rejects a token that is not yet valid', async () => {
    const token = await mintToken(keys, { notBeforeOffsetSeconds: 600 });
    await expect(verifier.verify(token)).rejects.toMatchObject({ code: 'not_yet_valid' });
  });

  it('rejects a token minted for a different audience', async () => {
    const token = await mintToken(keys, { audience: 'https://someone-else.example/mcp' });
    await expect(verifier.verify(token)).rejects.toMatchObject({ code: 'invalid_audience' });
  });

  it('rejects a token from a different issuer', async () => {
    const token = await mintToken(keys, { issuer: 'https://evil.example/realms/carbo' });
    await expect(verifier.verify(token)).rejects.toMatchObject({ code: 'invalid_issuer' });
  });

  it('honours a subject allowlist', async () => {
    const restricted = new TokenVerifier({
      jwksUri: keys.jwksUri,
      expectedIssuer: TEST_ISSUER,
      expectedAudience: TEST_AUDIENCE,
      clockToleranceSeconds: 5,
      allowedSubjects: ['only-this-subject'],
    });
    const token = await mintToken(keys, { subject: 'someone-else' });
    await expect(restricted.verify(token)).rejects.toMatchObject({ code: 'subject_not_allowed' });

    const allowed = await mintToken(keys, { subject: 'only-this-subject' });
    await expect(restricted.verify(allowed)).resolves.toMatchObject({ subject: 'only-this-subject' });
  });

  it('never puts token material into the error it raises', async () => {
    const token = await mintToken(keys, { expiresInSeconds: -600 });
    try {
      await verifier.verify(token);
      throw new Error('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      const message = (err as AuthError).message;
      expect(message).not.toContain(token);
      expect(message).not.toContain('eyJ');
    }
  });
});

describe('extractScopes', () => {
  it('parses the space-delimited scope claim', () => {
    const scopes = extractScopes({ scope: 'carbo:server:read carbo:n8n:read' });
    expect([...scopes].sort()).toEqual(['carbo:n8n:read', 'carbo:server:read']);
  });

  it('discards scopes this gateway does not define', () => {
    // A token from another audience must not be able to smuggle authority in.
    const scopes = extractScopes({ scope: 'carbo:server:read admin openid profile carbo:host:exec' });
    expect([...scopes]).toEqual(['carbo:server:read']);
  });

  it('accepts the array form as well', () => {
    const scopes = extractScopes({ scp: ['carbo:audit:read'] } as never);
    expect([...scopes]).toEqual(['carbo:audit:read']);
  });

  it('returns an empty set when there is no scope claim', () => {
    expect(extractScopes({}).size).toBe(0);
  });
});
